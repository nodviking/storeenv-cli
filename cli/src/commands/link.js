import path from "node:path";
import { StoreEnvError, normalizeRemote } from "@storeenv/core";
import { api } from "../services/api.js";
import { ensureAuthenticated } from "../services/auth.js";
import { isGitRepository, listRemotes } from "../services/git.js";
import { dim, info, line, setResult, success, warn } from "../services/output.js";
import { fetchProject, linkFolder, localRoot } from "../services/project.js";

export const command = "link [project]";
export const describe = "Point this folder at an existing project (writes .storeenv.json)";
export const builder = (yargs) =>
  yargs
    .positional("project", { type: "string", describe: "namespace/name or a project id; omitted, your project linked to this repository is used" })
    .option("remote", { type: "boolean", default: false, describe: "Also add this repository's remotes as links (project managers only)" })
    .option("force", { type: "boolean", default: false, describe: "Replace a different project in .storeenv.json" });

export const handler = async (argv) => {
  ensureAuthenticated();
  const cwd = process.cwd();
  const root = localRoot(cwd);
  const remotes = isGitRepository(cwd) ? listRemotes(cwd).filter((remote) => normalizeRemote(remote)) : [];

  let target = argv.project || process.env.STOREENV_PROJECT;
  if (!target) {
    // Only your own projects; a remote proves nothing about anyone else's.
    const { projects } = remotes.length ? await api.resolveProjects({ remotes }) : { projects: [] };
    const names = projects.filter((match) => match.via === "remote").map((match) => match.project.fullName).sort();
    if (names.length > 1) {
      throw new StoreEnvError("SE_PROJECT_AMBIGUOUS", `${names.length} of your projects are linked to this repository: ${names.join(", ")}.`, { hint: `Pick one: storeenv link ${names[0]}`, details: { projects: names } });
    }
    if (!names.length) throw new StoreEnvError("SE_INVALID", "Say which project to link.", { hint: "storeenv link <namespace/name>  (see storeenv projects)" });
    target = names[0];
  }

  const { project, role } = await fetchProject(target, "the project you named");
  const file = linkFolder(root, project, { force: argv.force });
  success(`Linked ${path.relative(cwd, root) || "this folder"} to ${project.fullName}  ${dim(project.id)}`);
  line(dim(`Wrote ${path.relative(cwd, file)}. Your role: ${role}.`));

  const added = [];
  if (argv.remote) {
    if (!remotes.length) warn("This folder has no Git remotes to link.");
    for (const remote of remotes) {
      try {
        const { link } = await api.addLink(project.id, { remote });
        added.push(link);
        warn(`Linked remote ${link.normalized} (unverified).`);
      } catch (error) {
        if (error.code === "SE_CONFLICT") info(`${normalizeRemote(remote).remote} was already linked.`);
        else throw error;
      }
    }
  }
  setResult({ project: { id: project.id, fullName: project.fullName }, role, config: file, links: added });
};
