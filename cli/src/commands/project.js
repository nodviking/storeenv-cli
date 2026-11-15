import { StoreEnvError } from "@storeenv/core";
import { api } from "../services/api.js";
import { bold, dim, line, setResult, success, table, warn } from "../services/output.js";
import { readSettings, saveProjectFile } from "../services/projectfile.js";
import { openProject } from "../services/session.js";

export const command = "project [action] [value]";
export const describe = "Show or change this project: show, rename, kind, describe, links, verify-link";
export const builder = (yargs) =>
  yargs
    .positional("action", { choices: ["show", "rename", "kind", "describe", "links", "verify-link"], default: "show", describe: "What to show or change about this project" })
    .positional("value", { type: "string", describe: "New name, kind (app or library), description, or a link id" });

const need = (value, label) => {
  if (value === undefined || value === "") throw new StoreEnvError("SE_INVALID", `Pass ${label}.`);
  return value;
};

export const handler = async (argv) => {
  const context = await openProject(argv);
  const { project } = context;

  if (argv.action === "show") {
    const { links } = await api.links(project.id);
    const { imports } = await api.imports(project.id);
    line(`${bold(project.fullName)}  ${dim(project.id)}`);
    line(`Kind        ${project.kind || "app"}`);
    if (project.description) line(`About       ${project.description}`);
    line(`Your role   ${context.role}`);
    line(`Found via   ${context.source}`);
    line(`Imports     ${imports.length}`);
    if (links.length) {
      line();
      table(["LINK", "PROVIDER", "STATE", "ID"], links.map((link) => [link.kind === "root_commit" ? `first commit ${link.value.slice(0, 12)}` : link.normalized, link.provider, link.verification, link.id]));
    }
    setResult({ project: { ...project, role: context.role }, links, imports: imports.length });
    return;
  }
  if (argv.action === "links") {
    const { links } = await api.links(project.id);
    if (!links.length) line(dim("No links. Add this folder's remotes: storeenv link --remote"));
    else table(["LINK", "PROVIDER", "STATE", "ID"], links.map((link) => [link.normalized, link.provider, link.verification, link.id]));
    setResult({ links });
    return;
  }
  if (argv.action === "verify-link") {
    const id = need(argv.value, "a link id (see storeenv project links)");
    try {
      const { link } = await api.verifyLink(project.id, id);
      success(`${link.normalized}: ${link.verification}${link.note ? `. ${link.note}` : ""}`);
      setResult({ link });
    } catch (error) {
      if (error.code === "SE_REMOTE_PROOF_REQUIRED") warn(error.hint || error.message);
      throw error;
    }
    return;
  }

  const body = {
    rename: () => ({ slug: need(argv.value, "the new project name") }),
    kind: () => ({ kind: need(argv.value, "app or library") }),
    describe: () => ({ description: argv.value || null }),
  }[argv.action]();
  const { project: updated } = await api.updateProject(project.id, body);
  // Keep the committed pointer's name in step; the id never changes.
  const settings = readSettings(context.root);
  if (settings.project === updated.id && settings.name !== updated.fullName) saveProjectFile(context.root, { ...settings, name: updated.fullName });
  success(argv.action === "rename" ? `Renamed to ${updated.fullName}. The old name keeps working as a redirect.` : `Saved ${updated.fullName}.`);
  setResult({ project: updated });
};
