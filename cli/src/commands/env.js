import { StoreEnvError, normalizeEnvironmentName, selectEnvironment } from "@storeenv/core";
import { api } from "../services/api.js";
import { chooseEnvironment, chosenEnvironment } from "../services/projectfile.js";
import { dim, line, setResult, success, table } from "../services/output.js";
import { requireTyped } from "../services/prompt.js";
import { openProject } from "../services/session.js";

export const command = "env <action> [name] [new-name]";
export const describe = "Manage environments: list, use, create, rename, protect, rm";
export const builder = (yargs) =>
  yargs
    .positional("action", { choices: ["ls", "list", "use", "create", "rename", "protect", "unprotect", "rm"], describe: "list environments, pick one for this folder (use), or create, rename, protect, unprotect or remove one" })
    .option("clear", { type: "boolean", default: false, describe: "With use: forget the choice for this folder" })
    .positional("name", { type: "string", describe: "Environment name" })
    .positional("new-name", { type: "string", describe: "New name (rename)" })
    .option("protected", { type: "boolean", default: false, describe: "Require production access (create)" });

export const handler = async (argv) => {
  // --env is a global option; for env subcommands the name is positional.
  const context = await openProject({ ...argv, env: undefined });
  const { project } = context;
  const need = (value, label) => {
    if (!value) throw Object.assign(new Error(`Pass ${label}.`), { code: "SE_INVALID", exit: 22 });
    return value;
  };

  if (argv.action === "use") {
    if (argv.clear) {
      chooseEnvironment(context.root, null);
      success("Cleared. Single environment commands follow --env, STOREENV_ENV and branch rules again.");
      setResult({ environment: null });
      return;
    }
    const name = normalizeEnvironmentName(need(argv.name, "an environment name"));
    const { environments } = await api.environments(project.id);
    if (!environments.some((env) => env.name === name)) {
      throw new StoreEnvError("SE_NOT_FOUND", `${project.fullName} has no environment ${name}.`, { hint: `See storeenv env list, or create it: storeenv env create ${name}` });
    }
    chooseEnvironment(context.root, name);
    success(`pull and run now use ${name} in this folder ${dim("(on this machine only; --env and STOREENV_ENV still win)")}`);
    setResult({ environment: name });
    return;
  }
  if (argv.action === "ls" || argv.action === "list") {
    const { environments, template } = await api.environments(project.id);
    const chosen = chosenEnvironment(context.root);
    const selected = selectEnvironment({ envVar: process.env.STOREENV_ENV, chosen, branch: context.branch, config: context.settings });
    table(
      ["ENVIRONMENT", "SOURCE", "FILES", "KEYS", "LATEST", ""],
      [
        ...environments.map((env) => [env.name, env.source, env.files, env.keys, env.head ? env.head.shortId : dim("none"), env.protected ? "protected" : ""]),
        ["template", "generated", template.files, template.keys, dim("none"), "read-only"],
      ],
    );
    if (selected) line(dim(`pull and run use ${selected.env} here (${selected.source}).`));
    setResult({ environments, selected });
    return;
  }
  if (argv.action === "create") {
    const { environment } = await api.createEnvironment(project.id, { name: need(argv.name, "a name"), protected: argv.protected });
    success(`Created environment ${environment.name}. It maps to .env.${environment.name}`);
    setResult({ environment });
    return;
  }
  if (argv.action === "rename") {
    const { environment } = await api.updateEnvironment(project.id, need(argv.name, "the current name"), { name: need(argv.newName, "the new name") });
    success(`Renamed ${argv.name} to ${environment.name}.`);
    return;
  }
  if (argv.action === "protect" || argv.action === "unprotect") {
    await api.updateEnvironment(project.id, need(argv.name, "a name"), { protected: argv.action === "protect" });
    success(argv.action === "protect" ? `${argv.name} now requires production access.` : `${argv.name} is no longer protected.`);
    return;
  }
  await requireTyped(`Type ${need(argv.name, "a name")} to delete it:`, argv.name);
  await api.deleteEnvironment(project.id, argv.name);
  success(`Deleted environment ${argv.name}. Its versions are kept for 30 days.`);
};
