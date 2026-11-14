import { StoreEnvError, describeGrants, parseScopeArg } from "@storeenv/core";
import * as core from "@storeenv/core";
import { api } from "../services/api.js";
import { dim, line, setResult, success } from "../services/output.js";
import { openProject } from "../services/session.js";

export const command = "request <target>";
export const describe = "Ask admins for access to a file, an environment or specific keys";
export const builder = (yargs) =>
  yargs
    .positional("target", { type: "string", describe: "backend/.env.production, backend/.env.production:KEY_A,KEY_B or an environment name" })
    .option("reason", { type: "string", describe: "Why you need it" });

export const handler = async (argv) => {
  const { project } = await openProject(argv);
  const scopes = parseScopeArg(argv.target, core).filter((scope) => scope.type !== "project");
  if (!scopes.length) throw new StoreEnvError("SE_INVALID", `"${argv.target}" isn't a file, an environment or a list of keys.`);
  const result = await api.requestAccess(project.id, { scopes, reason: argv.reason });
  success(`Requested access to ${describeGrants({ role: "viewer", grants: scopes })}.`);
  line(dim("Admins were notified. You'll be told when it's approved."));
  setResult({ project: project.fullName, request: result.id });
};
