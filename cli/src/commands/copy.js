// storeenv copy: takes keys from another project into this one as real,
// independent secrets. It is the only path that re-encrypts (V1 §9.2):
// source values are decrypted on this device with your own key shares,
// then pushed to the destination like any push, encrypted for the
// destination's readers after the same key checks (vetPeople), with the
// server's compare-and-set on the parent version. The server never sees a
// value.

import { StoreEnvError, matchesImportFilter, normalizeEnvironmentName } from "@storeenv/core";
import { api } from "../services/api.js";
import { bold, changeSummary, dim, line, setResult, step, table, versionTag, warn } from "../services/output.js";
import { fetchProject } from "../services/project.js";
import { confirm } from "../services/prompt.js";
import { openProject } from "../services/session.js";
import { vetPeople } from "../services/trust.js";
import { readPolicy, verifyVersion, writer } from "../services/signing.js";
import { decryptFile, executePush, fetchHead, planPush } from "../services/versions.js";

export const command = "copy";
export const describe = "Copy keys from another project into this one (decrypted and re-encrypted on this device)";
export const builder = (yargs) =>
  yargs
    .option("from", { type: "string", demandOption: true, describe: "Source project: namespace/name or id" })
    .option("from-env", { type: "string", describe: "Source environment (default: the destination environment)" })
    .option("to", { type: "string", describe: "Destination project (default: this folder's project; same as --project)" })
    .option("only", { type: "string", array: true, describe: "Key patterns to copy, like STRIPE_* (default: all you can read)" })
    .option("service", { type: "string", describe: "Copy one service's keys only" })
    .option("message", { alias: "m", type: "string", describe: "Version message" })
    .option("dry-run", { type: "boolean", default: false, describe: "Show what would change and upload nothing" })
    .option("skip-unverified", { type: "boolean", default: false, describe: "Encrypt only for readers whose keys are verified; the rest wait for a key share" });

export const handler = async (argv) => {
  if (!argv.env) throw new StoreEnvError("SE_INVALID", "Pass --env, the destination environment.", { hint: "storeenv copy --from acme/shared-stripe --env production" });
  const environment = normalizeEnvironmentName(argv.env);
  const context = await openProject({ ...argv, project: argv.to || argv.project }, { identity: true });
  const { project, identity } = context;
  const { project: source } = await fetchProject(argv.from, "--from");
  const sourceEnv = normalizeEnvironmentName(argv.fromEnv || environment);
  if (source.id === project.id && sourceEnv === environment) throw new StoreEnvError("SE_INVALID", "Source and destination are the same environment.");

  const sourceHead = await fetchHead(source.id, sourceEnv);
  if (!sourceHead) throw new StoreEnvError("SE_NOT_FOUND", `${source.fullName} ${sourceEnv} has no versions.`);
  const destHead = await fetchHead(project.id, environment);
  // The copy is signed by this device, so the source must verify first: an
  // unsigned or forged value can't become a signed one here (laundering).
  await verifyVersion(sourceHead, { projectId: source.id, environment: sourceEnv }, readPolicy(argv, context, "source"));
  if (destHead) await verifyVersion(destHead, { projectId: project.id, environment }, readPolicy(argv, context, "compose"));

  // Destination files keep what they have; copied keys are laid over them.
  const files = [];
  let copied = 0;
  let unreadable = 0;
  for (const remoteFile of sourceHead.files.filter((file) => !argv.service || file.service === argv.service)) {
    const decrypted = decryptFile(remoteFile, identity, { projectId: source.id, environment: sourceEnv });
    unreadable += decrypted.pending + decrypted.notShared;
    const picked = decrypted.entries.filter((entry) => matchesImportFilter(entry.name, argv.only || []));
    if (!picked.length) continue;
    const destFile = destHead?.files.find((file) => file.service === remoteFile.service);
    const values = new Map();
    if (destFile) for (const entry of decryptFile(destFile, identity, { projectId: project.id, environment }).entries) values.set(entry.name, entry.value);
    for (const entry of picked) values.set(entry.name, entry.value);
    copied += picked.length;
    files.push({ path: destFile?.path || remoteFile.path, service: remoteFile.service, environment, values, entries: [], issues: [] });
  }
  if (unreadable) warn(`${unreadable} source ${unreadable === 1 ? "key isn't" : "keys aren't"} readable by you and won't be copied.`);
  if (!files.length) throw new StoreEnvError("SE_NOT_FOUND", "Nothing to copy: no readable keys match.");

  // A throwaway cache pinned to the head just read: the server still refuses
  // the push if the destination moved in between (parent check).
  const cache = { files: {}, envs: { [environment]: destHead?.id || null } };
  const [plan] = await planPush({ projectId: project.id, files, cache, identity, force: false });
  line(`Copy      ${bold(`${source.fullName} ${sourceEnv}`)}  ->  ${bold(`${project.fullName} ${environment}`)}`);
  table(["SERVICE", "FILE", "CHANGES"], plan.files.map((item) => [item.file.service, item.file.path, changeSummary(item.changes.filter((change) => change.op !== "removed"))]));
  const lost = plan.files.flatMap((item) => item.changes.filter((change) => change.op === "removed"));
  if (lost.length) throw new StoreEnvError("SE_INTEGRITY", "Copy would remove destination keys; nothing was uploaded.", { hint: "Report this; copy only ever adds or replaces keys" });
  setResult({ from: `${source.fullName}:${sourceEnv}`, to: `${project.fullName}:${environment}`, keys: copied, changes: plan.changes });
  if (!plan.changes) {
    line("The destination already has these values. Nothing to copy.");
    return;
  }
  if (argv.dryRun) {
    line(dim("Dry run: nothing was uploaded."));
    return;
  }
  if (!(await confirm(`Copy ${plan.changes} ${plan.changes === 1 ? "key" : "keys"} into ${project.fullName} ${environment}? They become independent secrets of that project.`, true))) {
    line("Nothing was copied.");
    return;
  }

  const listed = await api.readers(project.id);
  const readers = await vetPeople(identity, listed.readers, { mode: argv.skipUnverified ? "skip" : "ask" });
  const signer = await writer(identity, context.user);
  const isProtected = listed.environments.find((item) => item.name === environment)?.protected ?? environment === "production";
  let result;
  await step(`Encrypting ${plan.encrypt} ${plan.encrypt === 1 ? "secret" : "secrets"} locally for ${project.fullName} and uploading...`, async () => {
    result = await executePush({ projectId: project.id, plan, readers, isProtected, message: argv.message || `Copy from ${source.fullName} ${sourceEnv}`, cache, identity, signer });
  });
  await api.logEvent(project.id, { action: "secrets.copied", env: environment, count: plan.changes }).catch(() => {});
  line(`${environment}  ${versionTag(result.version.id)}   "${result.version.message}"`);
  if (result.waiting.length) warn(`${result.waiting.map((login) => `@${login}`).join(", ")} can't decrypt yet.`);
  setResult({ version: result.version.id });
};
