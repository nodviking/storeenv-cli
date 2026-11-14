// The manifest describes what is on disk. The cache remembers what was last
// pushed or pulled, as keyed hashes, so status works offline and no plaintext
// is ever stored outside the env files themselves.

import path from "node:path";
import { keyedHash, parseEnv } from "@storeenv/core";
import { homeDir, readJson, writePrivateFile } from "./config.js";
import { readEnv } from "./filesystem.js";
import { classifyEnvironment, classifyService, isTemplateFile } from "./project.js";

// Turns one env file's text into a manifest entry.
export const fileFromText = (relative, text, settings = {}, { envOverride } = {}) => {
  const { entries, issues } = parseEnv(text);
  const service = classifyService(relative);
  if (isTemplateFile(relative)) return { template: { path: relative, service, keys: entries.map((entry) => entry.key) } };
  const environment = envOverride || classifyEnvironment(relative, settings);
  if (!environment) return {};
  return { file: { path: relative, service, environment, text, entries, issues, values: new Map(entries.map((entry) => [entry.key, entry.value])) } };
};

export const buildManifest = (root, paths, settings = {}, options = {}) => {
  const files = [];
  const templates = [];
  for (const relative of paths) {
    const { file, template } = fileFromText(relative, readEnv(path.join(root, relative)), settings, options);
    if (file) files.push(file);
    if (template) templates.push(template);
  }
  return { files, templates };
};

export const cachePath = (projectId) => path.join(homeDir(), "projects", `${projectId}.json`);

export const loadCache = (projectId) => {
  const cache = readJson(cachePath(projectId), null);
  return cache?.version === 1 ? cache : { version: 1, envs: {}, files: {} };
};

export const saveCache = (projectId, cache) => {
  writePrivateFile(cachePath(projectId), `${JSON.stringify(cache, null, 2)}\n`);
};

// Remembers the synced state of one file. entries: [{ name, value, entryId }]
export const recordFile = (cache, file, entries, cacheKey) => {
  const keys = {};
  for (const entry of entries) keys[entry.name] = { hash: keyedHash(cacheKey, entry.value), entryId: entry.entryId };
  cache.files[file.path] = { environment: file.environment, service: file.service, keys, syncedAt: new Date().toISOString() };
};

export const recordEnvironment = (cache, environment, versionId) => {
  cache.envs[environment] = versionId;
};

// Compares a file on disk with the last synced state.
export const diffAgainstCache = (cache, file, cacheKey) => {
  const cached = cache.files[file.path];
  if (!cached) return { known: false, changes: [...file.values.keys()].sort().map((key) => ({ key, op: "added" })) };
  const changes = [];
  for (const [key, value] of file.values) {
    const before = cached.keys[key];
    if (!before) changes.push({ key, op: "added" });
    else if (before.hash !== keyedHash(cacheKey, value)) changes.push({ key, op: "modified" });
  }
  for (const key of Object.keys(cached.keys)) {
    if (!file.values.has(key)) changes.push({ key, op: "removed" });
  }
  return { known: true, changes: changes.sort((a, b) => a.key.localeCompare(b.key)) };
};

export const cachedMatches = (cache, file, name, value, entryId, cacheKey) => {
  const cached = cache.files[file.path]?.keys?.[name];
  return Boolean(cached && cached.entryId === entryId && cached.hash === keyedHash(cacheKey, value));
};
