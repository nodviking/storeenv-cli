// .storeenv.json (V1 proposal §8): a committed pointer from a folder to a
// StoreEnv project, plus environment rules. It never holds secrets.
//
// Version 1 (CLI 0.1) had: localId, ignore, environments (path -> env).
// Version 2 adds: version, project, name, files (was environments),
// branches, imports. Reading always yields a v2 object; writing is the
// caller's job (see serializeProjectConfig).

import { StoreEnvError } from "./errors.js";
import { detectProvider, looksLikeSecret } from "./scanner.js";

export const CONFIG_VERSION = 2;
export const PROJECT_ID = /^prj_[0-9a-f]{24}$/;
export const ENV_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9._-]{0,63}$/;
const LOCAL_ID = /^[a-z0-9_-]{6,64}$/i;
const KNOWN = new Set(["$schema", "version", "project", "name", "files", "environments", "branches", "imports", "ignore", "localId", "writers"]);
// Writers the repository trusts (S1): "@login=SE:XXXX-XXXX-XXXX".
const WRITER = /^@?[a-z0-9][a-z0-9-]{0,38}=SE:[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/i;
const IMPORT_FIELDS = new Set(["from", "env", "into", "only", "pin"]);

const invalid = (problem, hint) =>
  new StoreEnvError("SE_CONFIG_INVALID", `.storeenv.json: ${problem}`, { hint: hint || "Fix the file, or remove it and run storeenv link" });

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// A path relative to the folder holding .storeenv.json, inside it.
const cleanPath = (key, field) => {
  const value = String(key).replace(/\\/g, "/").replace(/^\.\//, "");
  if (!value || value.startsWith("/") || /^[a-z]:/i.test(value) || value.split("/").includes("..")) {
    throw invalid(`"${key}" in ${field} must be a relative path inside this folder.`);
  }
  return value;
};

const envMap = (value, field, keyFn) => {
  if (value === undefined) return {};
  if (!isObject(value)) throw invalid(`${field} must be an object.`);
  const out = {};
  for (const [key, env] of Object.entries(value)) {
    if (typeof env !== "string" || !ENV_NAME.test(env)) {
      throw invalid(`${field}["${key}"] must be an environment name like "production" (lower case letters, digits, - and _).`);
    }
    out[keyFn(key, field)] = env;
  }
  return out;
};

const branchKey = (key, field) => {
  const value = String(key).trim();
  if (!value || /\s/.test(value) || (value.includes("*") && !(value === "*" || /^[^*]+\/\*$/.test(value)))) {
    throw invalid(`${field} key "${key}" must be a branch name, "prefix/*" or "*".`);
  }
  return value;
};

const validateImports = (value) => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid("imports must be an array.");
  return value.map((item, i) => {
    if (!isObject(item)) throw invalid(`imports[${i}] must be an object.`);
    // A typo must never silently widen an import, so unknown keys stop here.
    const unknown = Object.keys(item).filter((key) => !IMPORT_FIELDS.has(key));
    if (unknown.length) throw invalid(`imports[${i}] has unknown field${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}.`);
    if (typeof item.from !== "string" || !item.from) throw invalid(`imports[${i}].from must name a project.`);
    return { ...item };
  });
};

// Project names (namespace/name) and file or branch paths are long and can
// hold digits, which alone made them look like secrets. A value counts as a
// name or path only when it is lower case, made of path characters, has a
// "/" or starts with ".", isn't a provider key, and none of its segments is
// secret shaped (or a long hex run). Mixed case tokens, base64 and tokens
// without separators are still refused.
const HEX_RUN = /^(?=.*[0-9])(?=.*[a-f])[0-9a-f]{16,}$/;
const isNameOrPath = (text) =>
  /^[a-z0-9._*/-]+$/.test(text) && (text.includes("/") || text.startsWith(".")) && !detectProvider(text)
  && text.split("/").every((segment) => !looksLikeSecret(segment) && !HEX_RUN.test(segment));

// Never write anything that looks like a credential into a committed file.
const assertNoSecrets = (value, where = "") => {
  if (typeof value === "string") {
    // Project ids are long random strings by design, not credentials.
    if (!PROJECT_ID.test(value) && !isNameOrPath(value) && looksLikeSecret(value)) throw invalid(`${where || "a value"} looks like a secret. .storeenv.json is committed to Git and must never hold secrets.`, "Remove the value");
  } else if (Array.isArray(value)) value.forEach((item, i) => assertNoSecrets(item, `${where}[${i}]`));
  else if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      assertNoSecrets(key, where ? `a key in ${where}` : "a field name");
      assertNoSecrets(item, where ? `${where}.${key}` : key);
    }
  }
};

// Parses text or an object into { config, notices, migrated, readOnly }.
// Throws SE_CONFIG_INVALID with the exact problem; never guesses.
export const parseProjectConfig = (input) => {
  let raw = input;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input);
    } catch (error) {
      throw invalid(`not valid JSON (${error.message}).`);
    }
  }
  if (!isObject(raw)) throw invalid("must be a JSON object.");

  const notices = [];
  const version = raw.version === undefined ? 1 : raw.version;
  if (!Number.isInteger(version) || version < 1) throw invalid("version must be a whole number.");
  // A newer file is read for the fields this client knows and never written.
  const readOnly = version > CONFIG_VERSION;
  if (readOnly) notices.push(`.storeenv.json is version ${version}; this CLI understands version ${CONFIG_VERSION}. Update the CLI before changing it.`);

  if (raw.project !== undefined && (typeof raw.project !== "string" || !PROJECT_ID.test(raw.project))) {
    throw invalid(`"project" must be a project id like prj_ followed by 24 hex characters (found ${JSON.stringify(raw.project)}).`, "Run storeenv link <namespace/name> to fix the pointer");
  }
  if (raw.name !== undefined && (typeof raw.name !== "string" || !NAME.test(raw.name))) {
    throw invalid(`"name" must look like namespace/project (found ${JSON.stringify(raw.name)}).`);
  }
  if (raw.localId !== undefined && (typeof raw.localId !== "string" || !LOCAL_ID.test(raw.localId))) throw invalid("localId is malformed.");
  if (raw.ignore !== undefined && (!Array.isArray(raw.ignore) || raw.ignore.some((item) => typeof item !== "string"))) throw invalid("ignore must be a list of paths.");
  if (raw.writers !== undefined && (!Array.isArray(raw.writers) || raw.writers.some((item) => typeof item !== "string" || !WRITER.test(item)))) {
    throw invalid('writers must be a list like ["@ana=SE:1A2B-3C4D-5E6F"].', "Use each writer's fingerprint from storeenv whoami");
  }

  const legacy = envMap(raw.environments, "environments", cleanPath);
  const files = envMap(raw.files, "files", cleanPath);
  // v1 -> v2: environments (path -> env) becomes files; files wins on overlap.
  const migrated = raw.environments !== undefined && raw.files === undefined;
  for (const [file, env] of Object.entries(legacy)) {
    if (files[file] && files[file] !== env) notices.push(`files["${file}"] (${files[file]}) overrides the old environments entry (${env}).`);
    if (!files[file]) files[file] = env;
  }

  const unknown = Object.keys(raw).filter((key) => !KNOWN.has(key));
  if (unknown.length && !readOnly) notices.push(`.storeenv.json has fields this CLI doesn't use: ${unknown.join(", ")}. They are kept.`);

  const config = {
    version: CONFIG_VERSION,
    ...(raw.project ? { project: raw.project } : {}),
    ...(raw.name ? { name: raw.name } : {}),
    files,
    branches: envMap(raw.branches, "branches", branchKey),
    imports: validateImports(raw.imports),
    ...(raw.ignore ? { ignore: [...raw.ignore] } : {}),
    ...(raw.localId ? { localId: raw.localId } : {}),
    ...(raw.writers ? { writers: [...raw.writers] } : {}),
    // CLI 0.1 reads "environments"; keep it while it exists so old and new
    // clients put the same file in the same environment.
    ...(raw.environments !== undefined ? { environments: { ...files } } : {}),
    extra: Object.fromEntries(unknown.map((key) => [key, raw[key]])),
  };
  assertNoSecrets({ ...config, extra: undefined });
  return { config, notices, migrated: migrated || version < CONFIG_VERSION, readOnly, sourceVersion: version };
};

// The JSON written to disk: known fields in a stable order, unknown ones kept.
export const serializeProjectConfig = (config) => {
  const { extra = {}, ...known } = config;
  const out = { version: CONFIG_VERSION };
  for (const key of ["project", "name", "files", "branches", "imports", "ignore", "localId", "writers", "environments"]) {
    if (known[key] === undefined) continue;
    if (key === "branches" && !Object.keys(known.branches).length) continue;
    out[key] = known[key];
  }
  const text = `${JSON.stringify({ ...out, ...extra }, null, 2)}\n`;
  parseProjectConfig(text); // never write something we couldn't read back
  return text;
};

// The environment a branch maps to, or null: exact name, then the longest
// "prefix/*", then "*". A detached HEAD (no branch) never matches.
export const environmentForBranch = (branch, config = {}) => {
  const rules = config.branches || {};
  if (!branch || branch === "HEAD") return null;
  if (rules[branch]) return rules[branch];
  const prefix = Object.keys(rules)
    .filter((key) => key.endsWith("/*") && branch.startsWith(key.slice(0, -1)))
    .sort((a, b) => b.length - a.length)[0];
  if (prefix) return rules[prefix];
  return rules["*"] || null;
};

// Single environment commands (pull, run): explicit beats everything, and a
// branch rule never overrides an explicit choice. Returns { env, source }
// or null when nothing picks one (the command keeps its own default).
export const selectEnvironment = ({ flag, envVar, chosen, branch, config } = {}) => {
  if (flag) return { env: flag, source: "--env" };
  if (envVar) return { env: envVar, source: "STOREENV_ENV" };
  if (chosen) return { env: chosen, source: "storeenv env use" };
  const fromBranch = environmentForBranch(branch, config);
  if (fromBranch) return { env: fromBranch, source: `branch ${branch}` };
  return null;
};
