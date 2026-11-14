import { StoreEnvError, normalizeEnvironmentName, visibleText } from "@storeenv/core";
import { api } from "../services/api.js";
import { canDecrypt, decryptAt } from "../services/crypto.js";
import { findEnvFiles } from "../services/filesystem.js";
import { buildManifest } from "../services/manifest.js";
import { changeSymbol, dim, line, setResult } from "../services/output.js";
import { openProject } from "../services/session.js";
import { readPolicy, verifyVersion } from "../services/signing.js";
import { fetchHead } from "../services/versions.js";

export const command = "diff [base] [head]";
export const describe = "Key level diff between local files and the remote, or between two versions";
export const builder = (yargs) =>
  yargs
    .positional("base", { type: "string", describe: "Version id or env:<name>" })
    .positional("head", { type: "string", describe: "Version id or env:<name>" })
    .option("reveal", { type: "boolean", default: false, describe: "Show the values you can read" });

// Revealed values go to a terminal: control characters are shown escaped.
const show = (value, reveal) => (reveal && value !== undefined ? visibleText(value) : "");

const localDiff = async (argv, context) => {
  const { project, root, settings, identity } = context;
  let files = buildManifest(root, findEnvFiles(root, { ignore: settings.ignore || [], files: settings.files }), settings).files;
  if (argv.env) files = files.filter((file) => file.environment === normalizeEnvironmentName(argv.env));
  const report = [];
  let total = 0;
  const heads = new Map();

  for (const file of files) {
    if (!heads.has(file.environment)) {
      const head = await fetchHead(project.id, file.environment);
      if (head && argv.reveal) await verifyVersion(head, { projectId: project.id, environment: file.environment }, readPolicy(argv, context, "pull"));
      heads.set(file.environment, head);
    }
    const remoteFile = heads.get(file.environment)?.files.find((item) => item.service === file.service);
    const remote = new Map();
    const unreadable = new Set();
    for (const entry of remoteFile?.entries || []) {
      if (!entry.name) continue;
      if (canDecrypt(entry)) remote.set(entry.name, decryptAt(entry, identity.privateKey, { projectId: project.id, environment: file.environment, service: file.service }));
      else unreadable.add(entry.name);
    }
    const changes = [];
    for (const [key, value] of file.values) {
      if (unreadable.has(key)) continue;
      if (!remote.has(key)) changes.push({ key, op: "added", to: value });
      else if (remote.get(key) !== value) changes.push({ key, op: "modified", from: remote.get(key), to: value });
    }
    for (const [key, value] of remote) if (!file.values.has(key)) changes.push({ key, op: "removed", from: value });
    if (!changes.length) continue;
    total += changes.length;
    line(`${file.path}  ${dim(`(local vs ${file.environment})`)}`);
    for (const change of changes.sort((a, b) => a.key.localeCompare(b.key))) {
      const detail = argv.reveal ? (change.op === "modified" ? `  ${show(change.from, true)} -> ${show(change.to, true)}` : `  ${show(change.to ?? change.from, true)}`) : "";
      line(`  ${changeSymbol(change.op)} ${change.key}${dim(detail)}`);
    }
    report.push({ path: file.path, changes: changes.map(({ key, op }) => ({ key, op })) });
  }
  if (!total) line("No differences between local files and the remote.");
  return report;
};

const versionDiff = async (argv, context) => {
  const { project, identity } = context;
  // With one version given, compare it to the latest of its environment.
  const head = argv.head || `env:${argv.env ? normalizeEnvironmentName(argv.env) : (await api.version(project.id, argv.base)).version.environment}`;
  const result = await api.compare(project.id, argv.base, head);
  if (argv.reveal) {
    // Revealed values: each entry's writer signature, signer and trust.
    for (const side of ["base", "head"]) {
      const files = result.files.map((file) => ({ service: file.service, entries: file.changes.map((change) => change[side]).filter((entry) => entry && canDecrypt(entry)) }));
      await verifyVersion({ files }, { projectId: project.id, environment: result[side].environment }, { ...readPolicy(argv, context, "pull"), entriesOnly: true, pinned: true });
    }
  }
  const report = [];
  for (const file of result.files) {
    if (!file.changes.length) continue;
    line(file.path);
    for (const change of file.changes) {
      let detail = "";
      if (argv.reveal) {
        const from = change.base && canDecrypt(change.base) ? decryptAt(change.base, identity.privateKey, { projectId: project.id, environment: result.base.environment, service: file.service }) : undefined;
        const to = change.head && canDecrypt(change.head) ? decryptAt(change.head, identity.privateKey, { projectId: project.id, environment: result.head.environment, service: file.service }) : undefined;
        detail = change.op === "modified" ? `  ${show(from, true) || "?"} -> ${show(to, true) || "?"}` : `  ${show(to ?? from, true) || "?"}`;
      }
      line(`  ${changeSymbol(change.op)} ${visibleText(change.key)}${dim(detail)}`);
    }
    report.push({ path: file.path, changes: file.changes.map(({ key, op }) => ({ key, op })) });
  }
  if (!report.length) line("These versions hold the same keys and values.");
  if (result.hiddenChanges) line(dim(`${result.hiddenChanges} changed ${result.hiddenChanges === 1 ? "key is" : "keys are"} outside your access.`));
  if (argv.reveal) await api.logEvent(project.id, { action: "compare.values_viewed", env: result.head.environment }).catch(() => {});
  return report;
};

export const handler = async (argv) => {
  const context = await openProject(argv, { identity: true });
  if (argv.base && !/^(env:)?[a-z0-9-]+$/i.test(argv.base)) throw new StoreEnvError("SE_INVALID", `"${argv.base}" isn't a version id.`);
  const files = argv.base ? await versionDiff(argv, context) : await localDiff(argv, context);
  if (!argv.reveal && files.length) line(dim("(values hidden; add --reveal to show values you can read)"));
  setResult({ project: context.project.fullName, files });
};
