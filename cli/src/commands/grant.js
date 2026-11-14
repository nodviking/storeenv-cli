import { api } from "../services/api.js";
import { dim, line, setResult, success } from "../services/output.js";
import { scopesFromFlags } from "../services/scopes.js";
import { autoShare, openProject } from "../services/session.js";

export const command = "grant <user>";
export const describe = "Change a member's role, scope, expiry or production access";
export const builder = (yargs) =>
  yargs
    .positional("user", { type: "string" })
    .option("role", { choices: ["viewer", "editor", "admin"] })
    .option("all", { type: "boolean", default: false, describe: "Grant the whole project" })
    .option("keys", { type: "string", array: true, describe: "Specific secrets: backend/.env.production:DB_HOST,DB_USER" })
    .option("files", { type: "string", array: true, describe: "Whole files: backend/.env.production" })
    .option("add", { type: "boolean", default: false, describe: "Add to the existing scope (default replaces it)" })
    .option("expires", { type: "string", describe: "24h, 7d, 30d or never" })
    .option("prod", { type: "boolean", describe: "Turn production access on or off (owner only)" });

export const handler = async (argv) => {
  const context = await openProject(argv, { identity: true });
  const { project, settings } = context;
  const login = argv.user.replace(/^@/, "");
  const scopes = argv.all ? [{ type: "project" }] : scopesFromFlags(argv, settings);
  const body = {};
  if (argv.role) body.role = argv.role;
  if (argv.prod !== undefined) body.prodAccess = argv.prod;
  if (argv.expires) body.expires = argv.expires;

  let result;
  if (scopes.length) {
    const current = argv.add ? (await api.member(project.id, login)).member.rawGrants : [];
    result = await api.setGrants(project.id, login, { ...body, grants: [...current, ...scopes] });
    success(`@${login} can now read: ${result.member.scope}`);
    if (result.rekey.length) line(dim(`${result.rekey.length} ${result.rekey.length === 1 ? "secret needs" : "secrets need"} a re-key. Run: storeenv revoke --resume`));
  } else {
    result = await api.updateMember(project.id, login, body);
    success(`Updated @${login}: ${result.member.role}, production ${result.member.prodAccess ? "on" : "off"}, scope ${result.member.scope}`);
  }
  await autoShare(context);
  setResult({ project: project.fullName, member: login, scope: result.member.scope });
};
