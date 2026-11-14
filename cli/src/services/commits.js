// Local commits: versions saved on this machine, offline, and uploaded
// later by "storeenv push" in the order they were made.
//
// Each commit is a snapshot of every env file in the repository. The file
// contents are encrypted with a key derived from this device's cache key,
// so the snapshot is as safe at rest as the identity itself.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StoreEnvError, decryptWithKey, deriveKey, diffValues, encryptWithKey, fromUtf8, newVersionId, utf8 } from "@storeenv/core";
import { homeDir, readJson, writePrivateFile } from "./config.js";
import { fileFromText } from "./manifest.js";
import { backupExisting, writeEnvFile } from "./writer.js";

const storePath = (root) => path.join(homeDir(), "local", `${createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 24)}.json`);

const commitKey = (identity) => deriveKey(identity.cacheKey, "storeenv/local-commits/v1");

export const loadStore = (root) => {
  const store = readJson(storePath(root), null);
  return store?.version === 1 ? store : { version: 1, root: path.resolve(root), projectId: null, commits: [] };
};

const saveStore = (root, store) => writePrivateFile(storePath(root), `${JSON.stringify(store, null, 2)}\n`);

// Online commands remember which project a repository belongs to, so
// offline commits can compare against what was last synced.
export const rememberProject = (root, projectId) => {
  const store = loadStore(root);
  if (store.projectId === projectId) return;
  store.projectId = projectId;
  saveStore(root, store);
};

export const listCommits = (root) => loadStore(root).commits;

// Decrypts a commit's files back into manifest entries.
export const commitFiles = (commit, identity, settings = {}) => {
  const key = commitKey(identity);
  return commit.files
    .map((file) => fileFromText(file.path, fromUtf8(decryptWithKey(key, file.text, `${commit.id}|${file.path}`)), settings).file)
    .filter(Boolean);
};

const keyedValues = (files) => new Map(files.map((file) => [file.path, file.values]));

// What changed between two sets of manifest files, per file path.
export const changesBetween = (before, after) => {
  const old = keyedValues(before);
  const changes = [];
  for (const file of after) {
    for (const change of diffValues(old.get(file.path) || new Map(), file.values)) changes.push({ path: file.path, environment: file.environment, ...change });
  }
  const now = new Set(after.map((file) => file.path));
  for (const file of before) {
    if (now.has(file.path)) continue;
    for (const key of file.values.keys()) changes.push({ path: file.path, environment: file.environment, key, op: "removed" });
  }
  return changes;
};

export const createCommit = ({ root, files, message, identity, changes }) => {
  if (!changes.length) return null;
  const store = loadStore(root);
  const id = newVersionId();
  const key = commitKey(identity);
  const commit = {
    id,
    message,
    createdAt: new Date().toISOString(),
    changes,
    files: files.map((file) => ({ path: file.path, environment: file.environment, text: encryptWithKey(key, utf8(file.text), `${id}|${file.path}`) })),
  };
  store.commits.push(commit);
  saveStore(root, store);
  return commit;
};

export const dropCommits = (root, ids) => {
  const store = loadStore(root);
  store.commits = store.commits.filter((commit) => !ids.includes(commit.id));
  saveStore(root, store);
};

export const findCommit = (root, ref) => {
  const matches = listCommits(root).filter((commit) => commit.id.startsWith(String(ref || "").toLowerCase()));
  if (!matches.length) throw new StoreEnvError("SE_NOT_FOUND", `No local commit ${ref}.`, { hint: "See them with: storeenv log --local" });
  if (matches.length > 1) throw new StoreEnvError("SE_INVALID", `Local commit id ${ref} is ambiguous. Use more characters.`);
  return matches[0];
};

// Writes a commit's files back to disk. Files that differ get a backup.
export const restoreCommit = (root, commit, identity, settings) => {
  const written = [];
  for (const file of commitFiles(commit, identity, settings)) {
    const target = path.join(root, file.path);
    const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
    if (current === file.text) continue;
    const backup = current === null ? null : backupExisting(root, file.path);
    writeEnvFile(root, file.path, file.text);
    written.push({ path: file.path, backup });
  }
  return written;
};
