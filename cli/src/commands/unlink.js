import fs from "node:fs";
import path from "node:path";
import { StoreEnvError, normalizeRemote } from "@storeenv/core";
import { api } from "../services/api.js";
import { ensureAuthenticated } from "../services/auth.js";
import { isGitRepository, listRemotes } from "../services/git.js";
import { dim, line, setResult, success } from "../services/output.js";
import { findProjectFile, loadProjectFile, saveProjectFile } from "../services/projectfile.js";

export const command = "unlink";
export const describe = "Remove this folder's pointer to its project (the project itself is untouched)";
export const builder = (yargs) =>
  yargs.option("remote", { type: "boolean", default: false, describe: "Also remove this repository's remotes from the project's links (managers only)" });

export const handler = async (argv) => {
  const found = findProjectFile(process.cwd());
  const config = found ? loadProjectFile(found.file).config : null;
  if (!config?.project && !config?.localId) throw new StoreEnvError("SE_PROJECT_NOT_LINKED", "This folder isn't linked to a project.");

  const removed = [];
  if (argv.remote && config.project) {
    ensureAuthenticated();
    const mine = new Set((isGitRepository(found.dir) ? listRemotes(found.dir) : []).map((remote) => normalizeRemote(remote)?.remote).filter(Boolean));
    const { links } = await api.links(config.project);
    for (const link of links.filter((item) => item.kind === "remote" && mine.has(item.normalized))) {
      await api.removeLink(config.project, link.id);
      removed.push(link.normalized);
    }
  }

  // Environment rules and ignores stay; only the pointer goes.
  const { project, name, localId, ...rest } = config;
  const keep = Object.keys(rest.files || {}).length || Object.keys(rest.branches || {}).length || rest.ignore?.length || rest.imports?.length || Object.keys(rest.extra || {}).length;
  if (keep) saveProjectFile(found.dir, rest);
  else fs.unlinkSync(found.file);
  success(`Unlinked ${path.relative(process.cwd(), found.dir) || "this folder"} from ${name || project || localId}.`);
  if (removed.length) line(dim(`Removed links: ${removed.join(", ")}`));
  setResult({ unlinked: project || localId, removedLinks: removed, configKept: Boolean(keep) });
};
