import { api } from "../services/api.js";
import { dim, line, setResult, success } from "../services/output.js";
import { scopesFromFlags } from "../services/scopes.js";
import { openProject } from "../services/session.js";

export const command = "invite <users..>";
export const describe = "Invite people by email or StoreEnv username, with a role and scope";
export const builder = (yargs) =>
  yargs
    .positional("users", { type: "string", array: true, describe: "@username or email" })
    .option("role", { choices: ["viewer", "editor", "admin"], default: "viewer" })
    .option("keys", { type: "string", array: true, describe: "Specific secrets: backend/.env.production:DB_HOST,DB_USER" })
    .option("files", { type: "string", array: true, describe: "Whole files: backend/.env.production" })
    .option("expires", { type: "string", describe: "Access expiry: 24h, 7d, 30d" })
    .option("prod", { type: "boolean", default: false, describe: "Give production access (owner only)" })
    .option("message", { alias: "m", type: "string" });

export const handler = async (argv) => {
  const { project, settings } = await openProject(argv);
  const grants = scopesFromFlags(argv, settings);
  const { invites } = await api.invite(project.id, {
    invitees: argv.users,
    role: argv.role,
    grants: grants.length ? grants : [{ type: "project" }],
    expires: argv.expires,
    prodAccess: argv.prod,
    message: argv.message,
  });
  for (const invite of invites) {
    if (invite.skipped) line(dim(`${invite.invitee} is ${invite.skipped}.`));
    else {
      success(`Invitation sent to ${invite.invitee}${argv.expires ? ` (access expires in ${argv.expires})` : ""}.`);
      line(dim(`  Invite link: ${invite.link}`));
    }
  }
  line(dim("Keys are shared once they accept and set up their key."));
  setResult({ project: project.fullName, invites });
};
