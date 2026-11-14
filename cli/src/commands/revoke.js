import { api } from "../services/api.js";
import { dim, line, setResult, step, success, warn } from "../services/output.js";
import { requireTyped } from "../services/prompt.js";
import { openProject } from "../services/session.js";
import { rekeyPending } from "../services/sharing.js";
import { readPolicy } from "../services/signing.js";

export const command = "revoke [user]";
export const describe = "Remove a member's access and re-key what they could read";
export const builder = (yargs) =>
  yargs
    .positional("user", { type: "string" })
    .option("resume", { type: "boolean", default: false, describe: "Finish a re-key that is still pending" })
    .option("rotation", { type: "boolean", default: true, describe: "Mark the affected secrets as rotation due" })
    .option("skip-unverified", { type: "boolean", default: false, describe: "Encrypt only for readers whose keys are verified; the rest wait for a key share" });

export const handler = async (argv) => {
  const context = await openProject(argv, { identity: true });
  const { project, identity } = context;

  if (!argv.resume) {
    if (!argv.user) throw Object.assign(new Error("Pass a member, for example: storeenv revoke @bob"), { code: "SE_INVALID", exit: 22 });
    const login = argv.user.replace(/^@/, "");
    const preview = await api.revokePreview(project.id, login);
    line(`@${login} could read ${preview.secrets.length} ${preview.secrets.length === 1 ? "secret" : "secrets"}.`);
    await requireTyped(`Type @${login} to revoke their access:`, `@${login}`);
    await api.revokeMember(project.id, login, { confirm: login, markRotation: argv.rotation });
    success(`@${login} can no longer read ${project.fullName}.`);
  }

  let result;
  await step("Re-keying (new ESKs, re-wrapped for remaining members)...", async () => {
    result = await rekeyPending(project.id, identity, { mode: argv.skipUnverified ? "skip" : "ask", policy: readPolicy(argv, context, "source") });
  });
  if (!result.tasks.length) {
    line("Nothing needs a re-key.");
    return;
  }
  if (result.blocked.length) {
    warn(`${result.blocked.length} ${result.blocked.length === 1 ? "secret is" : "secrets are"} outside your access. Another reader must run: storeenv revoke --resume`);
  }
  if (result.secrets.length) {
    const names = [...new Set(result.secrets.map((secret) => secret.name))];
    line();
    warn("They may have copied these values. Rotate them at the provider:");
    line(`    ${names.join(", ")}     ${dim('(marked "rotation due")')}`);
  }
  setResult({ project: project.fullName, rekeyed: result.secrets, versions: result.versions.map((version) => version.id) });
};
