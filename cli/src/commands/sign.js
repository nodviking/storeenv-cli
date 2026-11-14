// storeenv sign: re-signs values written before writer signatures, or by a
// device that was revoked since. The values are shown by
// name first: signing says "I vouch for these", so check them. They are
// re-encrypted with fresh keys, signed by this device, and pushed as a new
// version; nothing else changes.

import { StoreEnvError, newVersionId, normalizeEnvironmentName } from "@storeenv/core";
import { CLIENT_VERSION, api } from "../services/api.js";
import { decryptAt, encryptEntry } from "../services/crypto.js";
import { bold, dim, line, setResult, success, warn } from "../services/output.js";
import { confirm } from "../services/prompt.js";
import { openProject } from "../services/session.js";
import { readPolicy, signNewEntry, signNewVersion, verifyVersion, writer } from "../services/signing.js";
import { vetPeople } from "../services/trust.js";
import { fetchHead } from "../services/versions.js";

export const command = "sign";
export const describe = "Re-sign values that aren't signed by a trusted, current device (after checking them)";
export const builder = (yargs) =>
  yargs.option("skip-unverified", { type: "boolean", default: false, describe: "Encrypt only for readers whose keys are verified" });

export const handler = async (argv) => {
  const context = await openProject(argv, { identity: true });
  const { project, identity, user } = context;
  const signer = await writer(identity, user);
  if (!signer) throw new StoreEnvError("SE_UNSIGNED", "This device can't sign yet.", { hint: "Run storeenv keys signing-setup (needs your recovery phrase), or approve this device from one that signs" });

  const { environments } = await api.environments(project.id);
  const names = argv.env ? [normalizeEnvironmentName(argv.env)] : environments.filter((env) => env.head).map((env) => env.name);
  const listed = await api.readers(project.id);
  const readers = await vetPeople(identity, listed.readers, { mode: argv.skipUnverified ? "skip" : "ask" });
  const report = [];

  for (const environment of names) {
    const head = await fetchHead(project.id, environment);
    if (!head) continue;
    // Forged values (bad signatures, uncertified signers) still stop here.
    const { unsigned, revoked, signed } = await verifyVersion(head, { projectId: project.id, environment }, { ...readPolicy(argv, context, "pull"), collect: true });
    const targets = [...unsigned, ...revoked];
    const hidden = head.files.flatMap((file) => file.entries.filter((entry) => !(entry.shared && entry.wrappedEsk) && !entry.signature)).length;
    if (signed && !targets.length) {
      line(`${environment}  already signed`);
      report.push({ environment, signed: 0 });
      continue;
    }
    if (!targets.length) {
      line(`${environment}  nothing you can read needs signing`);
      continue;
    }
    line(`${bold(environment)}: ${targets.length} ${targets.length === 1 ? "value" : "values"} to check and sign:`);
    for (const { entry, service } of targets) line(`  ${service === "root" ? "" : `${service}/`}${entry.name}${revoked.includes(targets.find((item) => item.entry === entry)) ? dim("  (signed by a revoked device)") : ""}`);
    if (hidden) warn(`${hidden} unsigned ${hidden === 1 ? "value isn't" : "values aren't"} readable by you; a writer who can read ${hidden === 1 ? "it" : "them"} must sign ${hidden === 1 ? "it" : "them"}.`);
    if (!(await confirm(`Did you check these, and sign them as ${user.login}?`, false))) {
      line("Nothing was signed.");
      continue;
    }

    const isProtected = Boolean(listed.environments.find((env) => env.name === environment)?.protected);
    const ids = new Set(targets.map(({ entry }) => entry.id));
    const files = head.files.map((file) => ({
      service: file.service,
      path: file.path,
      entries: file.entries.map((entry) => {
        if (!ids.has(entry.id)) return { ref: entry.id };
        const where = { projectId: project.id, environment, service: file.service };
        return signNewEntry(encryptEntry({ ...where, name: entry.name, value: decryptAt(entry, identity.privateKey, where), rev: entry.rev + 1, readers, isProtected }), where, signer);
      }),
    }));
    const id = newVersionId();
    const { version } = await api.createVersion(project.id, environment, {
      id, parent: head.id, kind: "push", message: `Sign ${ids.size} ${ids.size === 1 ? "value" : "values"}`, clientVersion: CLIENT_VERSION, files,
      ...signNewVersion({ id, parent: head.id, projectId: project.id, environment, kind: "push", head, files }, signer),
    });
    success(`${environment}  signed ${ids.size} ${ids.size === 1 ? "value" : "values"}  (v ${version.shortId})`);
    report.push({ environment, signed: ids.size, version: version.id });
  }
  setResult({ project: project.fullName, environments: report });
};
