import { StoreEnvError } from "@storeenv/core";
import { api } from "../services/api.js";
import { dim, line, setResult, success, table } from "../services/output.js";
import { openProject } from "../services/session.js";

export const command = "import [action] [args..]";
export const describe = "Import environments from shared library projects: list, add, remove, pin, unpin, enable, disable, move";
export const builder = (yargs) =>
  yargs
    .positional("action", { choices: ["list", "add", "remove", "pin", "unpin", "enable", "disable", "move", "used-by"], default: "list", describe: "What to do with this environment's imports" })
    .positional("args", { type: "string", array: true, describe: "add: the source project (namespace/name). Other actions: an import id from storeenv import list, then a source version id (pin) or a position, 0 first (move)" })
    .option("from-env", { type: "string", describe: "Source environment (default: the same name as --env)" })
    .option("only", { type: "string", array: true, describe: "Key patterns to import, like STRIPE_* (default: all keys you can read)" })
    .option("pin", { type: "string", describe: "With add: stay on this source version id instead of following the latest" });

const need = (value, label) => {
  if (!value) throw new StoreEnvError("SE_INVALID", `Pass ${label}.`);
  return value;
};

export const handler = async (argv) => {
  const { project } = await openProject({ ...argv, env: undefined });
  const [first, second] = argv.args || [];
  const env = argv.env ? String(argv.env) : undefined;

  if (argv.action === "list") {
    const { imports } = await api.imports(project.id, env);
    if (!imports.length) line(dim(`No imports${env ? ` into ${env}` : ""}. Add one: storeenv import add <namespace/library> --env <env>`));
    else table(["ID", "INTO", "FROM", "SOURCE ENV", "KEYS", "VERSION", "STATE"], imports.map((item) => [
      item.id, item.env, item.source.hidden ? dim("a project you can't access") : item.source.fullName, item.sourceEnv,
      item.filter.length ? item.filter.join(",") : "all", item.pin ? `pinned ${item.pin.slice(0, 11)}` : "latest", item.enabled ? (item.sourceDeleted ? "source deleted" : "on") : "off",
    ]));
    setResult({ imports });
    return;
  }
  if (argv.action === "used-by") {
    const used = await api.usedBy(project.id);
    line(`${used.count} ${used.count === 1 ? "project imports" : "projects import"} ${project.fullName}.`);
    for (const item of used.projects) line(`  ${item.fullName}`);
    if (used.count > used.projects.length) line(dim(`  ${used.count - used.projects.length} more you are not a member of`));
    setResult(used);
    return;
  }
  if (argv.action === "add") {
    const source = need(first, "the source project (namespace/name)");
    const into = need(env, "--env, the environment to import into");
    const { import: created } = await api.addImport(project.id, { env: into, source, sourceEnv: argv.fromEnv || into, filter: argv.only || [], pin: argv.pin });
    success(`${project.fullName} ${into} now imports ${created.source.fullName} ${created.sourceEnv}${created.filter.length ? ` (${created.filter.join(", ")})` : ""}${created.pin ? `, pinned` : ""}.`);
    line(dim("Each teammate gets these values only if they can read the source themselves. Local keys win."));
    setResult({ import: created });
    return;
  }
  const id = need(first, "an import id (see storeenv import list)");
  if (argv.action === "remove") {
    await api.removeImport(project.id, id);
    success("Import removed. The source project is unchanged.");
    setResult({ removed: id });
    return;
  }
  const body = {
    pin: () => ({ pin: need(second, "a source version id") }),
    unpin: () => ({ pin: null }),
    enable: () => ({ enabled: true }),
    disable: () => ({ enabled: false }),
    move: () => ({ position: Number.parseInt(need(second, "a position (0 is first, later ones win)"), 10) }),
  }[argv.action]();
  const { import: updated } = await api.updateImport(project.id, id, body);
  success(`Import ${id} updated.`);
  setResult({ import: updated });
};
