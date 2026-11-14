import { StoreEnvError, assertSafeRemotePath, formatValue, isDotenvExact, isProcessControlVar, normalizeEnvironmentName, selectEnvironment, shortId, visibleText } from "@storeenv/core";
import { chosenEnvironment } from "../services/projectfile.js";
import { fetchImports, writeImportsFile } from "../services/imports.js";
import { api } from "../services/api.js";
import { findEnvFiles } from "../services/filesystem.js";
import { buildManifest, loadCache, recordEnvironment, saveCache } from "../services/manifest.js";
import { added, bold, changeSymbol, command as cmd, dim, line, setResult, warn } from "../services/output.js";
import { choose } from "../services/prompt.js";
import { autoShare, openProject } from "../services/session.js";
import { readPolicy, verifyVersion } from "../services/signing.js";
import { fetchHead, planPullFile, recordPulledFile, renderPulledFile } from "../services/versions.js";
import { backupExisting, writeEnvFile } from "../services/writer.js";

export const command = "pull";
export const describe = "Download, decrypt and write the env files you can read";
export const builder = (yargs) =>
  yargs
    .version(false)
    .option("service", { type: "string", describe: "Pull the files of one service only" })
    .option("version", { type: "string", describe: "Pull an exact version id" })
    .option("all", { type: "boolean", default: false, describe: "Pull every environment you can read" })
    .option("force", { type: "boolean", default: false, describe: "Overwrite local changes (a backup is kept)" })
    .option("stdout", { type: "boolean", default: false, describe: "Print the decrypted file and write nothing (logged)" })
    .option("imports", { type: "boolean", default: true, describe: "Also write imported keys to .storeenv/imports/<env>.env (--no-imports to skip)" });

// --env, STOREENV_ENV, "storeenv env use", then a branch rule pick one
// environment. Without any of them: default plus every environment that
// has a file here (as before). A detached HEAD never picks by branch.
export const singleEnvironment = (argv, context) =>
  selectEnvironment({
    flag: argv.env ? normalizeEnvironmentName(argv.env) : null,
    envVar: process.env.STOREENV_ENV ? normalizeEnvironmentName(process.env.STOREENV_ENV) : null,
    chosen: chosenEnvironment(context.root),
    branch: context.branch,
    config: context.settings,
  });

const pickEnvironments = async (argv, context) => {
  const single = argv.all ? null : singleEnvironment(argv, context);
  if (single) {
    if (single.source !== "--env") line(dim(`Environment ${single.env} (${single.source})`));
    return [single.env];
  }
  const { environments } = await api.environments(context.project.id);
  const remote = environments.filter((env) => env.head).map((env) => env.name);
  if (argv.all) return remote;
  // Default: "default" plus every environment whose file already exists here.
  const local = new Set(buildManifest(context.root, findEnvFiles(context.root, { ignore: context.settings.ignore || [], files: context.settings.files }), context.settings).files.map((file) => file.environment));
  const picked = remote.filter((name) => name === "default" || local.has(name));
  return picked.length ? picked : remote.slice(0, 1);
};

export const handler = async (argv) => {
  const context = await openProject(argv, { identity: true });
  const { project, root, identity } = context;
  const cache = loadCache(project.id);
  const pinned = argv.version ? (await api.version(project.id, argv.version)).version : null;
  const environments = pinned ? [pinned.environment] : await pickEnvironments(argv, context);
  if (!environments.length) throw new StoreEnvError("SE_NOT_FOUND", "This project has no versions yet.", { hint: "Run storeenv push first" });

  let restored = 0;
  let needMore = null;
  let pendingKeys = 0;
  const report = [];

  // Imported keys (V1 §9): decrypted here with your own source keys and
  // written apart from your env files, so they are never pushed as copies.
  const pullImports = async (environment, ownNames) => {
    if (pinned || argv.stdout || argv.imports === false || argv.service) return;
    const imports = await fetchImports(project.id, environment, identity, { verify: readPolicy(argv, context, "pull") });
    if (!imports.length) return;
    const own = Object.fromEntries([...ownNames].map((name) => [name, true]));
    const { relative, count } = writeImportsFile(root, environment, own, imports);
    for (const item of imports) line(dim(`  imports ${item.source} ${item.sourceEnv}${item.pin ? ` (pinned ${item.version})` : ""}: ${Object.keys(item.values).length} keys`));
    if (count) line(`  ${added(`${relative}      ${count} imported ${count === 1 ? "key" : "keys"}`)}   ${dim("(local keys win)")}`);
    report.push({ path: relative, environment, status: "imports", keys: count });
  };

  for (const environment of environments) {
    const version = pinned || (await fetchHead(project.id, environment));
    if (!version) {
      warn(`${environment} has no versions yet.`);
      await pullImports(environment, new Set());
      continue;
    }
    const ownNames = new Set();
    if (!argv.stdout) line(`Project   ${bold(project.fullName)}   environment ${environment}   ${dim(`v ${version.shortId || shortId(version.id)}`)}`);
    const files = version.files.filter((file) => !argv.service || file.service === argv.service);
    let keys = 0;
    // Every path and every name is checked before the first file is written.
    await verifyVersion(version, { projectId: project.id, environment }, { ...readPolicy(argv, context, "pull"), pinned: Boolean(pinned) });
    const mapped = Object.keys(context.settings?.files || {});
    if (!argv.stdout) for (const remoteFile of files) assertSafeRemotePath(remoteFile.path, mapped);
    const plans = files.map((remoteFile) => ({ remoteFile, plan: planPullFile({ root, remoteFile, projectId: project.id, environment, cache, identity }) }));

    for (const { remoteFile, plan } of plans) {
      const risky = plan.remote.entries.filter((entry) => isProcessControlVar(entry.name)).map((entry) => entry.name);
      if (risky.length) warn(`${remoteFile.path} sets ${risky.join(", ")}, which change how programs start. storeenv run refuses them unless you pass --allow-env. Check who wrote them.`);
      const inexact = plan.remote.entries.filter((entry) => !isDotenvExact(entry.value)).map((entry) => entry.name);
      if (inexact.length && !argv.stdout) warn(`${inexact.join(", ")} in ${remoteFile.path} ${inexact.length === 1 ? "holds" : "hold"} every kind of quote and a backslash; StoreEnv reads ${inexact.length === 1 ? "it" : "them"} back exactly, other dotenv parsers keep the backslashes.`);
      for (const entry of plan.remote.entries) ownNames.add(entry.name);
      for (const name of plan.remote.hiddenNames || []) ownNames.add(name);
      keys += plan.remote.entries.length;
      pendingKeys += plan.remote.pending;

      if (argv.stdout) {
        process.stdout.write(`# ${remoteFile.path} (${environment})\n`);
        // A terminal gets control characters as escapes; a pipe gets the bytes.
        const shown = (text) => (process.stdout.isTTY ? visibleText(text) : text);
        for (const entry of plan.remote.entries) process.stdout.write(`${entry.name}=${shown(formatValue(entry.value))}\n`);
        await api.logEvent(project.id, { action: "secret.exported", env: environment, service: remoteFile.service, count: plan.remote.entries.length }).catch(() => {});
        continue;
      }

      const total = plan.remote.total;
      const readable = plan.remote.entries.length;
      const note = readable === total ? `${total} ${total === 1 ? "key" : "keys"}` : `${readable} of ${total} keys   ${dim(`(${plan.remote.notShared ? `${plan.remote.notShared} not shared with you` : ""}${plan.remote.notShared && plan.remote.pending ? ", " : ""}${plan.remote.pending ? `${plan.remote.pending} waiting for a key share` : ""})`)}`;
      if (plan.remote.notShared) needMore = remoteFile.path;

      if (!readable && !plan.exists) {
        line(`  ${dim(`${remoteFile.path}      ${note}`)}`);
        continue;
      }
      if (plan.upToDate) {
        line(`  ${dim(`= ${remoteFile.path}      up to date`)}`);
        recordPulledFile(cache, plan, identity);
        report.push({ path: remoteFile.path, environment, status: "up to date", keys: readable });
        continue;
      }

      let action = "o";
      if (plan.localChanges.length && !argv.force) {
        warn(`${remoteFile.path} has ${plan.localChanges.length} local ${plan.localChanges.length === 1 ? "change" : "changes"} that were never pushed:`);
        line(`      ${plan.localChanges.map((change) => `${changeSymbol(change.op)} ${change.key}`).join("      ")}`);
        for (;;) {
          action = await choose("What should happen to your local file?", [
            { key: "k", label: "Keep my local file", hint: "nothing is written" },
            { key: "o", label: "Overwrite with the remote version", hint: "a backup is kept" },
            { key: "d", label: "Show the differences first" },
            { key: "a", label: "Abort the pull" },
          ], null);
          if (action === null) throw new StoreEnvError("SE_LOCAL_CHANGES", `Pull would overwrite unpushed changes in ${remoteFile.path}.`, { hint: "Run storeenv push first, or pull --force to overwrite (a backup is kept)" });
          if (action !== "d") break;
          const remoteNames = new Map(plan.remote.entries.map((entry) => [entry.name, entry.value]));
          for (const change of plan.localChanges) {
            line(`      ${changeSymbol(change.op)} ${change.key}   ${dim(change.op === "added" ? "only on this machine" : change.op === "removed" ? "deleted on this machine" : remoteNames.has(change.key) ? "differs from remote" : "")}`);
          }
        }
        if (action === "a") throw new StoreEnvError("SE_LOCAL_CHANGES", "Pull aborted. Nothing was written.");
        if (action === "k") {
          line(`  ${dim(`  kept ${remoteFile.path}`)}`);
          report.push({ path: remoteFile.path, environment, status: "kept local", keys: readable });
          continue;
        }
      }

      const backup = plan.exists && plan.localChanges.length ? backupExisting(root, remoteFile.path) : null;
      writeEnvFile(root, remoteFile.path, renderPulledFile(plan));
      recordPulledFile(cache, plan, identity);
      restored += 1;
      line(`  ${added(`${remoteFile.path}      ${note}`)}${backup ? dim(`   backup: ${backup}`) : ""}`);
      report.push({ path: remoteFile.path, environment, status: "written", keys: readable, total, backup });
    }

    if (version.hiddenFiles) line(dim(`  ${version.hiddenFiles} more ${version.hiddenFiles === 1 ? "file" : "files"} you don't have access to`));
    if (!pinned && !argv.service) recordEnvironment(cache, environment, version.id);
    if (!argv.stdout) await api.logEvent(project.id, { action: "env.pulled", env: environment, count: keys }).catch(() => {});
    await pullImports(environment, ownNames);
  }

  if (argv.stdout) return;
  saveCache(project.id, cache);
  await api.syncDevice(project.id, cache.envs).catch(() => {});
  line(`Restored ${restored} ${restored === 1 ? "file" : "files"}.`);
  if (pendingKeys) {
    line();
    warn(`${pendingKeys} ${pendingKeys === 1 ? "secret is" : "secrets are"} waiting for a key share. A member's device will share them soon.`);
  }
  if (needMore) {
    line();
    line(`${dim("Need more keys? Ask an admin:")}  ${cmd(`storeenv request ${needMore}`)}`);
  }
  await autoShare(context);
  setResult({ project: project.fullName, restored, files: report, pendingKeys });
};
