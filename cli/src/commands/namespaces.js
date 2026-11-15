import { StoreEnvError } from "@storeenv/core";
import { api } from "../services/api.js";
import { ensureAuthenticated } from "../services/auth.js";
import { dim, line, setResult, success, table, warn } from "../services/output.js";

// Namespaces (users, organizations, unowned names from 0.1). Claims follow
// the server's rules: GitHub org admins win at once, anything else waits for
// an operator, and competing claims stay disputed. A claim never gives access
// to the existing projects in a namespace.
export const command = "namespaces [action] [handle]";
export const describe = "Namespaces: list, view, projects, claim, status";
export const builder = (yargs) =>
  yargs
    .positional("action", { choices: ["list", "view", "projects", "claim", "status"], default: "list", describe: "list your namespaces, view one, list its projects, claim a name left over from 0.1, or see a claim's status" })
    .positional("handle", { type: "string", describe: "Namespace name" })
    .example("storeenv namespaces view acme", "Who owns acme, and whether it is disputed")
    .example("storeenv namespaces claim acme", "Claim a name left over from StoreEnv 0.1");

const need = (value) => {
  if (!value) throw new StoreEnvError("SE_INVALID", "Pass a namespace name.");
  return String(value).toLowerCase();
};

const describeKind = (namespace) =>
  namespace.kind === "legacy" ? "unclaimed name from StoreEnv 0.1" : namespace.kind === "org" ? "organization" : "personal";

export const handler = async (argv) => {
  ensureAuthenticated();

  if (argv.action === "list") {
    // The namespaces you can create projects in.
    const [{ user }, { orgs }] = await Promise.all([api.me(), api.orgs()]);
    const rows = [[user.login, "personal", "owner"], ...orgs.map((org) => [org.slug, "organization", org.role])];
    table(["NAMESPACE", "KIND", "YOUR ROLE"], rows);
    line(dim("You can create projects in your own namespace and in organizations where you are owner or admin."));
    setResult({ namespaces: rows.map(([handle, kind, role]) => ({ handle, kind, role })) });
    return;
  }

  const handle = need(argv.handle);
  if (argv.action === "view") {
    const { namespace } = await api.namespace(handle);
    line(`${namespace.handle}   ${describeKind(namespace)}${namespace.status === "disputed" ? "   DISPUTED" : ""}`);
    if (namespace.renamedFrom) line(dim(`${namespace.renamedFrom} was renamed to ${namespace.handle}.`));
    if (namespace.kind === "legacy") line(dim(`No one owns it yet, so no one can create projects in it. Claim it: storeenv namespaces claim ${namespace.handle}`));
    setResult({ namespace });
    return;
  }
  if (argv.action === "projects") {
    const { namespace, projects } = await api.namespaceProjects(handle);
    if (!projects.length) line(dim(`No projects in ${namespace.handle} that you can see.`));
    else table(["PROJECT", "YOUR ROLE"], projects.map((project) => [project.fullName, project.role || dim("listed for admins, no access")]));
    setResult({ namespace, projects });
    return;
  }
  if (argv.action === "claim") {
    const { claim, namespace } = await api.claimNamespace(handle);
    if (claim.status === "approved") success(`You now own ${namespace.handle} (${claim.method}). Existing projects in it keep their members; you gained no access to them.`);
    else if (claim.status === "disputed") warn(`${namespace.handle} is disputed: someone else claimed it too. It stays locked until an operator decides.`);
    else line(`Your claim on ${namespace.handle} is pending review. You'll get a notification when it is decided.`);
    setResult({ claim, namespace });
    return;
  }
  // status
  const { claims } = await api.namespaceClaims(handle);
  if (!claims.length) line(dim(`You have no claims on ${handle}.`));
  else table(["CLAIM", "STATUS", "METHOD", "CREATED"], claims.map((claim) => [claim.id, claim.status, claim.method, String(claim.createdAt).slice(0, 10)]));
  setResult({ claims });
};
