import { StoreEnvError, shortId, timeAgo } from "@storeenv/core";
import { changesBetween, commitFiles, createCommit, dropCommits, listCommits, loadStore } from "../services/commits.js";
import { findEnvFiles } from "../services/filesystem.js";
import { hasLocalIdentity, loadIdentity } from "../services/identity.js";
import { buildManifest, diffAgainstCache, loadCache } from "../services/manifest.js";
import { bold, changeSymbol, command as cmd, dim, line, setResult, success } from "../services/output.js";
import { localRoot, readProjectFile } from "../services/project.js";
import { blocking, scan } from "../services/scanner.js";

export const command = "commit";
export const describe = "Save a version of your env files on this machine. Works offline; storeenv push uploads it later";
export const builder = (yargs) =>
  yargs
    .option("message", { alias: "m", type: "string", describe: "Commit message" })
    .option("undo", { type: "boolean", default: false, describe: "Drop the last local commit (your files are not touched)" });

// Everything here runs without the network.
const openLocal = () => {
  if (!hasLocalIdentity()) throw new StoreEnvError("SE_DEVICE_NOT_ENROLLED", "This device has no StoreEnv key yet.", { hint: "Run storeenv login once while online" });
  const root = localRoot();
  return { root, settings: readProjectFile(root), identity: loadIdentity() };
};

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

export const handler = async (argv) => {
  const { root, settings, identity } = openLocal();

  if (argv.undo) {
    const commits = listCommits(root);
    const last = commits[commits.length - 1];
    if (!last) {
      line("There are no local commits to undo.");
      return;
    }
    dropCommits(root, [last.id]);
    success(`Dropped local commit ${shortId(last.id)} "${last.message}". Your files were not changed.`);
    setResult({ dropped: last.id });
    return;
  }

  const files = buildManifest(root, findEnvFiles(root, { ignore: settings.ignore || [], files: settings.files }), settings).files;
  if (!files.length) throw new StoreEnvError("SE_NO_ENV_FILES");
  const errors = blocking(scan(root, files));
  if (errors.length) throw new StoreEnvError("SE_PARSE_ERROR", errors[0].message, { hint: "Fix the line or quote the value, then commit again" });

  // Compare with the last local commit, or with what was last synced.
  const commits = listCommits(root);
  const last = commits[commits.length - 1];
  let changes;
  let against;
  if (last) {
    changes = changesBetween(commitFiles(last, identity, settings), files);
    against = `local commit ${shortId(last.id)}`;
  } else {
    const { projectId } = loadStore(root);
    const cache = projectId ? loadCache(projectId) : { files: {} };
    changes = files.flatMap((file) => diffAgainstCache(cache, file, identity.cacheKey).changes.map((change) => ({ path: file.path, environment: file.environment, ...change })));
    against = projectId ? "the last synced version" : "nothing (first commit)";
  }

  if (!changes.length) {
    line(`Nothing to commit. Your env files match ${against}.`);
    setResult({ committed: null });
    return;
  }

  const message = (argv.message || "").trim() || `Update ${plural(changes.length, "key")}`;
  const commit = createCommit({ root, files, message, identity, changes });
  success(`${bold(`[local ${shortId(commit.id)}]`)} ${message}`);
  const byPath = new Map();
  for (const change of changes) byPath.set(change.path, [...(byPath.get(change.path) || []), change]);
  for (const [path, list] of byPath) line(`  ${path.padEnd(28)} ${list.map((change) => `${changeSymbol(change.op)} ${change.key}`).join("  ")}`);
  const pending = commits.length + 1;
  line();
  line(dim(`${plural(pending, "local commit")} not pushed. Upload with ${cmd("storeenv push")}, undo with ${cmd("storeenv commit --undo")}.`));
  setResult({ committed: { id: commit.id, message, changes } });
};

export const describeCommit = (commit) => ({
  id: commit.id,
  shortId: shortId(commit.id),
  message: commit.message,
  createdAt: commit.createdAt,
  ago: timeAgo(commit.createdAt),
  changes: commit.changes,
});

