// Works out which StoreEnv project the current folder belongs to, and
// classifies env files into services and environments.
//
// Resolution order, first match wins:
//   1. --project <namespace/name | prj_id>
//   2. STOREENV_PROJECT
//   3. .storeenv.json, the nearest one walking up (Git or not)
//   4. Git remotes linked to one of *your* projects
//   5. root commit: only ever a suggestion
//   6. nothing: create or link (interactively, or with an explicit --yes)
// A remote or a root commit is a hint. It never proves ownership, and the
// server only ever answers with projects the caller is a member of.

import path from "node:path";
import {
  PROJECT_ID, StoreEnvError, classifyEnvironment as coreEnvironment, classifyService as coreService, isTemplateFileName,
  normalizeRemote, parseProjectSlug,
} from "@storeenv/core";
import { api } from "./api.js";
import { currentBranch, getRepositoryRoot, isGitRepository, listRemotes, rootCommit } from "./git.js";
import { info, line, warn } from "./output.js";
import { PROJECT_FILE, findProjectFile, loadProjectFile, readSettings, saveProjectFile } from "./projectfile.js";
import { choose, explicitYes, input, isInteractive } from "./prompt.js";

export { PROJECT_FILE };

export const readProjectFile = (root) => readSettings(root);
export const writeProjectFile = (root, data) => saveProjectFile(root, data);

export const classifyService = (relativePath) => coreService(relativePath);

// files in .storeenv.json decide first, then the file suffix.
export const classifyEnvironment = (relativePath, settings = {}) => {
  const mapped = settings.files?.[relativePath] || settings.environments?.[relativePath];
  if (mapped) return mapped;
  return coreEnvironment(relativePath);
};

export const isTemplateFile = (relativePath) => isTemplateFileName(relativePath.split("/").pop());

// The folder a project lives in: where .storeenv.json is, else the Git
// root, else the current directory. Works offline.
export const localRoot = (cwd = process.cwd()) => {
  const found = findProjectFile(cwd);
  if (found) return found.dir;
  return isGitRepository(cwd) ? getRepositoryRoot(cwd) : path.resolve(cwd);
};

const notAccessible = (what, source) =>
  new StoreEnvError("SE_NOT_FOUND", `${what} (from ${source}) doesn't exist or you don't have access to it.`, {
    hint: source === PROJECT_FILE ? "Ask a project admin to invite you, or point this folder elsewhere: storeenv link <namespace/name>" : "Check the name or id, or ask a project admin to invite you",
  });

// A project by id or namespace/name; the server decides access.
export const fetchProject = async (value, source) => {
  const text = String(value || "").trim();
  let overview;
  try {
    if (PROJECT_ID.test(text)) overview = await api.projectById(text);
    else {
      const slug = parseProjectSlug(text);
      if (!slug) throw new StoreEnvError("SE_INVALID", `${source} must be namespace/name or a project id (prj_...), not "${text}".`);
      overview = await api.project(slug.owner, slug.name);
    }
  } catch (error) {
    if (["SE_NOT_FOUND", "SE_FORBIDDEN_SCOPE"].includes(error.code)) throw notAccessible(text, source);
    throw error;
  }
  return { project: overview.project, role: overview.me?.role || overview.role };
};

const fullNames = (matches) => matches.map((match) => match.project.fullName).sort();

const ambiguous = (matches, what) =>
  new StoreEnvError("SE_PROJECT_AMBIGUOUS", `${matches.length} of your projects are linked to ${what}: ${fullNames(matches).join(", ")}.`, {
    hint: `Pick one: storeenv link ${fullNames(matches)[0]}  (or pass --project)`,
    details: { projects: fullNames(matches) },
  });

// Steps 4 and 5. Returns { match } or { suggestions } (root commit only).
const fromGit = async (cwd) => {
  const remotes = listRemotes(cwd);
  if (remotes.length) {
    const known = remotes.filter((remote) => normalizeRemote(remote));
    const { projects } = known.length ? await api.resolveProjects({ remotes: known }) : { projects: [] };
    const viaRemote = projects.filter((match) => match.via === "remote");
    if (viaRemote.length > 1) throw ambiguous(viaRemote, remotes.length === 1 ? normalizeRemote(remotes[0])?.remote || remotes[0] : "this repository's remotes");
    if (viaRemote.length === 1) return { match: viaRemote[0], remotes };
  }
  const commit = rootCommit(cwd);
  if (commit) {
    const { projects } = await api.resolveProjects({ rootCommit: commit });
    if (projects.length) return { suggestions: projects, remotes };
  }
  return { remotes };
};

const projectName = (value) =>
  String(value || "project").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 64) || "project";

// Creates a project in a namespace you may use (the server checks), links
// this folder's remotes as unverified hints, and writes .storeenv.json.
export const createForFolder = async ({ root, name, namespace, kind, description, linkRemotes = true }) => {
  const { user } = await api.me();
  const handle = (namespace || user.login).toLowerCase();
  const slug = projectName(name || path.basename(root));
  const { project, role } = await api.createProject({ namespace: handle, slug, kind, description });
  const links = [];
  if (linkRemotes && isGitRepository(root)) {
    for (const remote of listRemotes(root).filter((item) => normalizeRemote(item))) {
      links.push((await api.addLink(project.id, { remote })).link);
    }
    const commit = rootCommit(root);
    if (commit) links.push((await api.addLink(project.id, { rootCommit: commit })).link);
  }
  const settings = readSettings(root);
  const file = saveProjectFile(root, { ...settings, project: project.id, name: project.fullName });
  return { project, role, links, file };
};

// Points a folder at a project. An existing pointer is replaced only on
// purpose (force), never as a side effect.
export const linkFolder = (root, project, { force = false } = {}) => {
  const settings = readSettings(root);
  if (settings.project && settings.project !== project.id && !force) {
    throw new StoreEnvError("SE_CONFLICT", `${PROJECT_FILE} already points at ${settings.name || settings.project}.`, { hint: "Run storeenv unlink first, or pass --force" });
  }
  return saveProjectFile(root, { ...settings, project: project.id, name: project.fullName });
};

export const resolveContext = async (argv = {}, { create = false } = {}) => {
  const cwd = process.cwd();
  const inRepo = isGitRepository(cwd);
  const found = findProjectFile(cwd);
  const root = found?.dir || (inRepo ? getRepositoryRoot(cwd) : path.resolve(cwd));
  const settings = found ? loadProjectFile(found.file).config : readSettings(root);
  const branch = inRepo ? currentBranch(cwd) : null;
  const base = { root, settings, inRepo, branch, configPath: found?.file || null, remote: null };

  // 1 and 2: explicit choices always win.
  const explicit = argv.project ? ["--project", argv.project] : process.env.STOREENV_PROJECT ? ["STOREENV_PROJECT", process.env.STOREENV_PROJECT] : null;
  if (explicit) {
    const { project, role } = await fetchProject(explicit[1], explicit[0]);
    return { ...base, project, role, source: explicit[0], remote: project.gitRemote || null };
  }

  // 3: the committed pointer. A dead pointer stops here; it never falls
  // through to some other project.
  if (settings.project) {
    const { project, role } = await fetchProject(settings.project, PROJECT_FILE);
    if (settings.name && settings.name !== project.fullName) info(`${PROJECT_FILE} calls this project ${settings.name}; it is now ${project.fullName}. Same project (${project.id}).`);
    return { ...base, project, role, source: PROJECT_FILE, remote: project.gitRemote || null };
  }
  if (settings.localId) {
    // A CLI 0.1 Git-less project. Still found the old way.
    const result = await api.lookupProject({ localId: settings.localId }).catch((error) => {
      if (error.code === "SE_NOT_FOUND") throw notAccessible(`The local project ${settings.localId}`, PROJECT_FILE);
      throw error;
    });
    return { ...base, project: result.project, role: result.role, source: `${PROJECT_FILE} (localId)`, local: true };
  }

  // 4 and 5: Git hints, member projects only.
  let suggestions = [];
  if (inRepo) {
    const git = await fromGit(cwd);
    if (git.match) {
      const { project, role, verification } = git.match;
      if (verification !== "verified") warn(`${project.fullName} was found through a remote link that isn't verified. Pin it: storeenv link ${project.fullName}`);
      return { ...base, project, role, source: "git remote", linkVerification: verification, remote: project.gitRemote || normalizeRemote(git.remotes[0])?.remote || null };
    }
    suggestions = git.suggestions || [];
  }

  // 6: nothing found.
  const suggestion = suggestions.length
    ? ` Your ${suggestions.length === 1 ? "project" : "projects"} ${fullNames(suggestions).join(", ")} ${suggestions.length === 1 ? "has" : "have"} the same first commit; if that's this folder, run: storeenv link ${fullNames(suggestions)[0]}`
    : "";
  if (create) {
    const created = await offerCreate({ root, suggestions });
    if (created) return { ...base, settings: readSettings(root), configPath: path.join(root, PROJECT_FILE), ...created };
  }
  throw new StoreEnvError("SE_PROJECT_NOT_LINKED", `This folder isn't linked to a StoreEnv project.${suggestion}`, {
    hint: "Create one: storeenv init   Use an existing one: storeenv link <namespace/name>",
  });
};

// Interactive create or link, or an explicit --yes. CI alone never creates.
const offerCreate = async ({ root, suggestions }) => {
  let action = null;
  if (isInteractive()) {
    action = await choose("This folder isn't linked to a StoreEnv project yet.", [
      { key: "create", label: `Create a new project (${projectName(path.basename(root))})` },
      { key: "link", label: "Link an existing project", hint: suggestions.length ? `suggested: ${fullNames(suggestions)[0]}` : "" },
      { key: "cancel", label: "Cancel" },
    ], "cancel");
  } else if (explicitYes()) action = "create";
  if (action === "create") {
    const { project, role, links, file } = await createForFolder({ root });
    line(`Created ${project.fullName} (${project.id}) and wrote ${path.relative(process.cwd(), file) || PROJECT_FILE}.`);
    for (const link of links.filter((item) => item.kind === "remote")) info(`Linked remote ${link.normalized} (unverified).`);
    return { project, role, source: "created", created: true };
  }
  if (action === "link") {
    const target = await input("Project (namespace/name or prj_ id):", suggestions.length ? fullNames(suggestions)[0] : "");
    const { project, role } = await fetchProject(target, "your answer");
    linkFolder(root, project);
    return { project, role, source: PROJECT_FILE };
  }
  return null;
};
