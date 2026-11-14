import { newVersionId, normalizeEnvironmentName } from "@storeenv/core";
import { api } from "../services/api.js";
import { changeSymbol, command as cmd, dim, line, setResult, versionTag } from "../services/output.js";
import { confirm, input, requireTyped } from "../services/prompt.js";
import { openProject } from "../services/session.js";
import { signRollback, writer } from "../services/signing.js";
import { requireIdentity } from "../services/identity.js";

export const command = "rollback <target>";
export const describe = "Create a new version equal to an older one (history is kept)";
export const builder = (yargs) =>
  yargs
    .positional("target", { type: "string", describe: "Version id to return to" })
    .option("message", { alias: "m", type: "string", describe: "Reason, saved as the version message" });

export const handler = async (argv) => {
  const { project } = await openProject(argv);
  const target = argv.env ? null : (await api.version(project.id, argv.target)).version;
  const environment = normalizeEnvironmentName(argv.env || target.environment);
  const preview = await api.rollbackPreview(project.id, environment, argv.target);

  line(`This creates a new version on ${environment} identical to ${preview.target.shortId}.`);
  line(`Keys affected:  ${preview.changes.map((change) => `${changeSymbol(change.op)} ${change.key}`).join("  ")}`);

  let message = argv.message;
  if (preview.protected) {
    if (!message) message = await input("Reason (required for protected environments):", "");
    await requireTyped(`Type ${environment} to confirm:`, environment);
  } else if (!(await confirm("History is kept. Continue?", false))) {
    line("Nothing was changed.");
    return;
  }

  // Signed by this device when it can sign. The API composes the files from
  // the target version; the signature covers exactly what it will store.
  let signer = null;
  try {
    const { user } = await api.me();
    signer = await writer(requireIdentity(user), user);
  } catch {
    signer = null;
  }
  const id = newVersionId();
  const signed = signer ? signRollback({ id, parent: preview.parent, projectId: project.id, environment, manifest: preview.manifest }, signer) : {};
  const { version } = await api.rollback(project.id, environment, { id, to: preview.target.id, message, ...(signer ? { parent: preview.parent, ...signed } : {}) });
  line(`${environment}  ${versionTag(version.id)}  "${version.message}"`);
  line(dim(`Run "${cmd(`storeenv pull --env ${environment}`)}" on machines that need it.`));
  setResult({ project: project.fullName, environment, version: { id: version.id, message: version.message }, changes: preview.changes });
};
