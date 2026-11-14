import { StoreEnvError } from "@storeenv/core";
import { api } from "../services/api.js";
import { ensureAuthenticated } from "../services/auth.js";
import { dim, line, setResult, success, table } from "../services/output.js";
import { requireTyped } from "../services/prompt.js";

// Organizations. Every rule (who may add admins, transfer, delete) is
// enforced by the server; this command only calls the existing API.
export const command = "orgs [action] [org] [login] [role]";
export const describe = "Organizations: list, create, view, members, add, role, remove, leave, transfer, delete";
export const builder = (yargs) =>
  yargs
    .positional("action", { choices: ["list", "create", "view", "members", "add", "role", "remove", "leave", "transfer", "delete"], default: "list" })
    .positional("org", { type: "string", describe: "Organization slug" })
    .positional("login", { type: "string", describe: "@username" })
    .positional("role", { type: "string", describe: "admin or member" })
    .option("name", { type: "string", describe: "Display name (create)" })
    .option("as", { choices: ["admin", "member"], default: "member", describe: "Role for add" })
    .example("storeenv orgs create acme --name 'Acme Inc'", "Create an organization you own")
    .example("storeenv orgs add acme @neha --as admin", "Add a member (only the owner can add admins)")
    .example("storeenv orgs transfer acme @neha", "Hand the organization to a member; you stay admin");

const need = (value, label) => {
  if (!value) throw new StoreEnvError("SE_INVALID", `Pass ${label}.`);
  return String(value).replace(/^@/, "").toLowerCase();
};

const showMembers = (org) =>
  table(["MEMBER", "ROLE", "KEY", "JOINED"], org.members.map((member) => [`@${member.login}`, member.role, member.hasIdentity ? "yes" : "not set up", member.joinedAt ? String(member.joinedAt).slice(0, 10) : ""]));

export const handler = async (argv) => {
  ensureAuthenticated();
  const action = argv.action;

  if (action === "list") {
    const { orgs } = await api.orgs();
    if (!orgs.length) line(dim("You're not in any organization. Create one: storeenv orgs create <slug>"));
    else table(["ORGANIZATION", "NAME", "ROLE", "MEMBERS"], orgs.map((org) => [org.slug, org.name, org.role, org.members]));
    setResult({ orgs });
    return;
  }

  const slug = need(argv.org, "an organization slug");
  if (action === "create") {
    const { org } = await api.createOrg({ slug, name: argv.name });
    success(`Created ${org.slug}. You are its owner. Projects can now live under ${org.slug}/.`);
    setResult({ org });
    return;
  }
  if (action === "view" || action === "members") {
    const { org, projects } = await api.org(slug);
    if (action === "view") {
      line(`${org.name} ${dim(`(${org.slug})`)}   your role: ${org.role}`);
      line(dim(`${org.members.length} ${org.members.length === 1 ? "member" : "members"}, ${org.teams.length} ${org.teams.length === 1 ? "team" : "teams"}`));
      if (projects.length) {
        line();
        table(["PROJECT", "YOUR ROLE"], projects.map((project) => [project.fullName, project.role || dim("listed for admins, no access")]));
      }
    } else showMembers(org);
    setResult({ org, projects });
    return;
  }
  if (action === "add") {
    const login = need(argv.login, "a @username");
    const { org } = await api.addOrgMember(slug, { login, role: argv.as });
    success(`Added @${login} to ${slug} as ${argv.as}. This gives no access to existing projects or their secrets.`);
    setResult({ org });
    return;
  }
  if (action === "role") {
    const login = need(argv.login, "a @username");
    const role = need(argv.role, "a role (admin or member)");
    const { org } = await api.setOrgRole(slug, login, role);
    success(`@${login} is now ${role} in ${slug}.`);
    setResult({ org });
    return;
  }
  if (action === "remove" || action === "leave") {
    const { user } = await api.me();
    const login = action === "leave" ? user.login : need(argv.login, "a @username");
    await api.removeOrgMember(slug, login);
    success(action === "leave" ? `You left ${slug}.` : `Removed @${login} from ${slug}.`);
    setResult({ removed: login });
    return;
  }
  if (action === "transfer") {
    const login = need(argv.login, "the new owner's @username");
    await requireTyped(`Type ${slug} to make @${login} the owner of ${slug}:`, slug);
    await api.transferOrg(slug, login);
    success(`@${login} now owns ${slug}. You are an admin.`);
    setResult({ owner: login });
    return;
  }
  // delete
  await requireTyped(`Type ${slug} to delete the organization:`, slug);
  await api.deleteOrg(slug);
  success(`Deleted ${slug}.`);
  setResult({ deleted: slug });
};
