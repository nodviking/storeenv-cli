import fs from "node:fs";
import path from "node:path";
import { StoreEnvError, buildTemplateText, normalizeRemote, timeAgo } from "@storeenv/core";
import { ensureAuthenticated } from "../services/auth.js";
import { getRepositoryRoot, isGitRepository, listRemotes } from "../services/git.js";
import { PROJECT_FILE, createForFolder } from "../services/project.js";
import { findProjectFile, loadProjectFile } from "../services/projectfile.js";
import { api } from "../services/api.js";
import { clone } from "../services/git.js";
import { added, command as cmd, dim, info, line, setResult, success, warn } from "../services/output.js";
import { resolveInside } from "../services/writer.js";

export const command = "init [repo-url]";
export const describe = "Create a StoreEnv project for this folder (Git optional), or with a repository URL scaffold its public template";
export const builder = (yargs) =>
  yargs
    .positional("repo-url", { type: "string", describe: "Public template mode: a repository URL, for example https://github.com/acme/cakeshop" })
    .option("name", { type: "string", describe: "Project name (default: the folder name)" })
    .option("namespace", { type: "string", describe: "Your username or an organization you administer (default: your username)" })
    .option("kind", { choices: ["app", "library"], default: "app", describe: "A library is shared by other projects" })
    .option("description", { type: "string", describe: "One line about the project" })
    .option("link-remotes", { type: "boolean", default: true, describe: "Add this repository's remotes as (unverified) links" })
    .option("new", { type: "boolean", default: false, describe: "Create a new project even if one of yours is already linked to this repository" })
    .option("clone", { type: "boolean", default: false, describe: "Also git clone the repository" })
    .option("suffix", { type: "string", describe: "Write .env.<suffix> files (use --suffix '' for plain .env)" })
    .option("force", { type: "boolean", default: false, describe: "Overwrite files that already exist" });

export const handler = async (argv) => {
  if (!argv.repoUrl) return createHere(argv);
  const remote = normalizeRemote(argv.repoUrl);
  if (!remote) throw new StoreEnvError("SE_INVALID", `"${argv.repoUrl}" isn't a repository URL.`);

  let template;
  try {
    template = await api.publicTemplate(remote.owner, remote.name);
  } catch (error) {
    if (error.code === "SE_NOT_FOUND") throw new StoreEnvError("SE_NOT_FOUND", `${remote.slug} has no public template.`, { hint: "Ask the maintainer to publish it in project settings" });
    throw error;
  }
  line(`Found public template for ${remote.slug} ${dim(`(updated ${template.updatedAt ? timeAgo(template.updatedAt) : "recently"})`)}`);

  let root = process.cwd();
  if (argv.clone) {
    root = path.join(process.cwd(), remote.name);
    clone(argv.repoUrl, root);
  }

  const suffix = argv.suffix === undefined ? "example" : String(argv.suffix);
  const fileName = suffix ? `.env.${suffix}` : ".env";
  const written = [];
  for (const service of template.services) {
    const relative = service.service === "root" ? fileName : `${service.service}/${fileName}`;
    const target = resolveInside(root, relative);
    if (fs.existsSync(target) && !argv.force) {
      warn(`${relative} already exists. Skipped (use --force to overwrite).`);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buildTemplateText(service.keys, { project: template.project, service: service.service }));
    line(added(`${relative.padEnd(28)} ${service.keys.length} ${service.keys.length === 1 ? "key" : "keys"}`));
    written.push({ path: relative, keys: service.keys.length });
  }
  line(dim(suffix ? `Fill in the values, then rename to .env.  Docs: storeenv.app/t/${remote.slug}` : `Fill in the values.  Docs: storeenv.app/t/${remote.slug}`));
  setResult({ project: template.project, files: written });
};

// storeenv init (no URL): a new project for this folder. Git isn't needed;
// remotes, when there are any, become unverified links.
const createHere = async (argv) => {
  ensureAuthenticated();
  const cwd = process.cwd();
  const inRepo = isGitRepository(cwd);
  const root = inRepo ? getRepositoryRoot(cwd) : path.resolve(cwd);

  const found = findProjectFile(cwd);
  if (found?.dir === root) {
    const { config } = loadProjectFile(found.file);
    if (config.project) {
      throw new StoreEnvError("SE_CONFLICT", `This folder is already linked to ${config.name || config.project}.`, { hint: "Run storeenv status, or storeenv unlink before creating another project" });
    }
  }

  // Duplicate check: one of *your* projects already on this repository.
  if (inRepo && !argv.new) {
    const remotes = listRemotes(root).filter((remote) => normalizeRemote(remote));
    const { projects } = remotes.length ? await api.resolveProjects({ remotes }) : { projects: [] };
    if (projects.length) {
      const names = projects.map((match) => match.project.fullName).sort();
      throw new StoreEnvError("SE_CONFLICT", `This repository is already linked to your ${names.length === 1 ? "project" : "projects"} ${names.join(", ")}.`, {
        hint: `Use it: storeenv link ${names[0]}   Or make another one: storeenv init --new`,
        details: { projects: names },
      });
    }
  }

  const { project, links, file } = await createForFolder({
    root, name: argv.name, namespace: argv.namespace, kind: argv.kind, description: argv.description, linkRemotes: argv.linkRemotes,
  });
  success(`Created ${project.fullName}  ${dim(project.id)}`);
  line(`Wrote ${path.relative(cwd, file) || PROJECT_FILE}  ${dim("(safe to commit: it holds the project id and environment rules, never secrets)")}`);
  for (const link of links) {
    if (link.kind === "remote") warn(`Linked remote ${link.normalized}. It is unverified: it helps teammates find the project, and proves nothing.`);
    else info(`Linked root commit ${link.value.slice(0, 12)} as a hint.`);
  }
  line(dim(`Next: ${cmd("storeenv push")} to upload your env files.`));
  setResult({ project: { id: project.id, fullName: project.fullName, kind: project.kind }, config: file, links });
};
