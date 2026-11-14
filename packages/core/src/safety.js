// Checks that run on every value a client received from the server before
// the value reaches a process, a file, the terminal or the page.
//
// The server and the database are not trusted with integrity here: a value
// can arrive under any name. Names are checked before anything is written or
// launched, and names that change how a program starts are never injected
// into a process unless the user allows each one by name.

import { IGNORED_DIRS, isEnvFileName } from "./classify.js";
import { buildAad } from "./crypto.js";
import { StoreEnvError } from "./errors.js";

export const MAX_ENV_NAME = 256;

// The same rule the API applies to pushed names (isValidKey). A remote name
// outside it can only come from a modified server or database.
const STRICT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const isSafeEnvName = (name) => typeof name === "string" && name.length <= MAX_ENV_NAME && STRICT_NAME.test(name);

// Variables that load code, change which binary runs or change how TLS and
// shells behave. Compared case insensitively, because Windows environment
// names are case insensitive.
export const PROCESS_CONTROL_VARS = Object.freeze([
  "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_REPL_EXTERNAL_MODULE",
  "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT",
  "PATH", "PATHEXT", "COMSPEC", "SHELL", "IFS", "BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "PS4", "PROMPT_COMMAND", "ZDOTDIR",
  "PYTHONSTARTUP", "PYTHONPATH", "PYTHONHOME", "PYTHONINSPECT",
  "PERL5OPT", "PERL5LIB", "PERLLIB", "RUBYOPT", "RUBYLIB",
  "GIT_SSH", "GIT_SSH_COMMAND", "GIT_EXEC_PATH", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_ASKPASS", "SSH_ASKPASS",
  "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS", "CLASSPATH",
  "DOTNET_STARTUP_HOOKS", "CORECLR_PROFILER", "CORECLR_PROFILER_PATH", "CORECLR_ENABLE_PROFILING",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE",
  "EDITOR", "VISUAL", "PAGER", "BROWSER",
]);
const CONTROL_SET = new Set(PROCESS_CONTROL_VARS);
const CONTROL_PREFIXES = ["DYLD_", "LD_", "GIT_CONFIG_", "NPM_CONFIG_", "STOREENV_"];

export const isProcessControlVar = (name) => {
  const upper = String(name).toUpperCase();
  return CONTROL_SET.has(upper) || CONTROL_PREFIXES.some((prefix) => upper.startsWith(prefix));
};

// Throws before any sink is touched if a remote entry name is unusable.
export const assertSafeEnvNames = (names, where = "the server") => {
  const bad = [...names].filter((name) => !isSafeEnvName(name));
  if (bad.length) {
    throw new StoreEnvError("SE_UNSAFE_ENV", `Refused ${bad.length === 1 ? "a key" : `${bad.length} keys`} from ${where} with an invalid name: ${bad.map((name) => JSON.stringify(String(name).slice(0, 64))).join(", ")}. Nothing was written or run.`, { details: { invalid: bad.map(String) } });
  }
};

// The AAD of an entry must be the one this client expects for where it
// asked to read. A mismatch means the entry was moved or renamed.
export const expectedAad = ({ projectId, environment, service, name, rev }) => buildAad({ projectId, environment, service, name, rev });

export const assertEntryLocation = (entry, { projectId, environment, service }) => {
  if (!projectId || !environment || !service) throw new StoreEnvError("SE_INTEGRITY", "A value was read without its expected location.");
  if (!Number.isInteger(entry.rev) || entry.rev < 1) throw new StoreEnvError("SE_INTEGRITY", `Key ${String(entry.name).slice(0, 64)} has an invalid revision.`);
  const want = expectedAad({ projectId, environment, service, name: entry.name, rev: entry.rev });
  if (entry.aad !== want) throw new StoreEnvError("SE_INTEGRITY", `Key ${String(entry.name).slice(0, 64)} isn't bound to ${environment}/${service} of this project. Nothing was written or run.`);
};

// A file path from the server, before pull writes to it. Only env file
// names are accepted, plus paths this repository maps in .storeenv.json
// (its own trusted configuration). Nothing under .git, node_modules and
// the other ignored folders, so a forged path can't replace a Git hook,
// .npmrc, .envrc (sourced by direnv) or a package file.
export const isSafeRemotePath = (filePath, mapped = []) => {
  if (typeof filePath !== "string" || !filePath || filePath.length > 512) return false;
  if (/[\u0000-\u001f\u007f\\:]/.test(filePath) || filePath.startsWith("/")) return false;
  const segments = filePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || IGNORED_DIRS.includes(segment))) return false;
  return isEnvFileName(segments.at(-1)) || mapped.includes(filePath);
};

export const assertSafeRemotePath = (filePath, mapped = []) => {
  if (!isSafeRemotePath(filePath, mapped)) {
    throw new StoreEnvError("SE_UNSAFE_ENV", `Refused to write ${JSON.stringify(String(filePath).slice(0, 120))}: the server named a file that isn't an env file of this repository. Nothing was written.`, { hint: "Map the path in .storeenv.json files if it really is one of your env files" });
  }
};

// Text shown on a terminal: control characters (escape sequences that move
// the cursor, rewrite the title or hide text) are shown as escapes.
export const visibleText = (value) =>
  String(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
