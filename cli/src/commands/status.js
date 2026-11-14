import path from "node:path";
import { compareWithTemplate, timeAgo } from "@storeenv/core";
import { singleEnvironment } from "./pull.js";
import { api } from "../services/api.js";
import { listCommits } from "../services/commits.js";
import { findEnvFiles } from "../services/filesystem.js";
import { hasLocalIdentity, loadIdentity } from "../services/identity.js";
import { buildManifest, diffAgainstCache, loadCache } from "../services/manifest.js";
import { bold, changeSymbol, command as cmd, dim, line, setResult, warn } from "../services/output.js";
import { autoShare, openProject } from "../services/session.js";

export const command = "status";
export const describe = "Show local changes and newer remote versions";

export const handler = async (argv) => {
  const context = await openProject(argv);
  const { project, root, settings } = context;
  const { user } = await api.me();
  const cache = loadCache(project.id);
  const manifest = buildManifest(root, findEnvFiles(root, { ignore: settings.ignore || [], files: settings.files }), settings);
  const { environments } = await api.environments(project.id);
  const identity = hasLocalIdentity() ? loadIdentity() : null;

  line(`On project ${bold(project.fullName)}   ${dim(`(signed in as @${user.login})`)}`);
  line(dim(`Project id ${project.id}, found via ${context.source}${context.configPath ? ` (${path.relative(process.cwd(), context.configPath) || ".storeenv.json"})` : ""}`));
  const single = singleEnvironment(argv, context);
  line(dim(`Branch ${context.inRepo ? context.branch || "detached HEAD" : "none (no Git)"}; pull and run use ${single ? `${single.env} (${single.source})` : "default and the environments of files here"}`));

  const behind = [];
  for (const env of environments) {
    if (!env.head) continue;
    const known = cache.envs[env.name];
    if (known === env.head.id) continue;
    const local = manifest.files.some((file) => file.environment === env.name);
    if (!known && !local) continue;
    behind.push({ environment: env.name, id: env.head.id, shortId: env.head.shortId, author: env.head.author, at: env.head.createdAt });
    line(`Remote has a newer version on ${env.name} ${dim(`(v ${env.head.shortId} by @${env.head.author}, ${timeAgo(env.head.createdAt)})`)}`);
  }

  const changed = [];
  const untracked = [];
  for (const file of manifest.files) {
    if (!cache.files[file.path]) {
      untracked.push(file);
      continue;
    }
    if (!identity) continue;
    const diff = diffAgainstCache(cache, file, identity.cacheKey);
    if (diff.changes.length) changed.push({ file, changes: diff.changes });
  }

  if (changed.length) {
    line();
    line("Changes not pushed:");
    const width = Math.max(...changed.map((item) => item.file.path.length));
    for (const item of changed) {
      line(`  ${item.file.path.padEnd(width)}   ${item.changes.map((change) => `${changeSymbol(change.op)} ${change.key}`).join("   ")}`);
    }
  }
  if (untracked.length) {
    line();
    line("Untracked env files:");
    const knownServices = new Set(Object.values(cache.files).map((file) => file.service));
    const width = Math.max(...untracked.map((file) => file.path.length));
    for (const file of untracked) {
      line(`  ${file.path.padEnd(width)}   ${dim(knownServices.has(file.service) || !Object.keys(cache.files).length ? `(${file.environment})` : `(new service "${file.service}")`)}`);
    }
  }

  // A committed .env.example is compared against the generated template.
  if (manifest.templates.length) {
    try {
      const template = await api.template(project.id);
      for (const file of manifest.templates) {
        const service = template.services.find((item) => item.service === file.service);
        if (!service) continue;
        const drift = compareWithTemplate(service.keys.map((key) => key.name), file.keys);
        if (drift.missingInFile.length || drift.extraInFile.length) {
          line();
          warn(`${file.path} differs from the generated template: ${[...drift.missingInFile.map((key) => `+ ${key}`), ...drift.extraInFile.map((key) => `- ${key}`)].join("  ")}`);
        }
      }
    } catch {
      // The template check is a courtesy. Status still works without it.
    }
  }

  const localCommits = listCommits(root);
  if (localCommits.length) {
    line();
    line(`${localCommits.length} local ${localCommits.length === 1 ? "commit" : "commits"} not pushed yet. ${dim("(storeenv log --local)")}`);
  }

  line();
  if (!changed.length && !untracked.length && !behind.length && !localCommits.length) line("Nothing to push or pull. Everything is up to date.");
  else line(dim(`Use "${cmd("storeenv push")}" to upload, "${cmd("storeenv pull")}" to update.`));
  if (!identity) warn("This device can't decrypt yet, so local changes can't be compared. Run: storeenv login");

  if (identity) await autoShare({ ...context, identity });
  setResult({
    project: project.fullName,
    projectId: project.id,
    source: context.source,
    linkVerification: context.linkVerification || null,
    environment: single,
    behind,
    changed: changed.map((item) => ({ path: item.file.path, changes: item.changes })),
    untracked: untracked.map((file) => file.path),
    localCommits: localCommits.map((commit) => ({ id: commit.id, message: commit.message, createdAt: commit.createdAt, changes: commit.changes })),
  });
};
