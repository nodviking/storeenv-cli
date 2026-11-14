// The push and pull engines. Commands call these in order and print the
// results. Nothing here writes to the terminal.

import path from "node:path";
import { StoreEnvError, assertEntryLocation, assertSafeEnvNames, newVersionId, parseEnv, serializeEnv } from "@storeenv/core";
import { CLIENT_VERSION, api } from "./api.js";
import { canDecrypt, decryptAt, decryptEntry, encryptEntry, waitingFor } from "./crypto.js";
import { exists, readEnv } from "./filesystem.js";
import { signNewEntry, signNewVersion } from "./signing.js";
import { cachedMatches, diffAgainstCache, recordEnvironment, recordFile } from "./manifest.js";

export const fetchHead = async (projectId, environment) => {
  try {
    return (await api.head(projectId, environment)).version;
  } catch (error) {
    if (error.code === "SE_NOT_FOUND" && /Environment/.test(error.message)) return null;
    throw error;
  }
};

// Decides, per file, which secrets are new, changed, removed or carried
// forward. Unchanged secrets keep their entry and are never re-encrypted.
export const planPush = async ({ projectId, files, cache, identity, force }) => {
  const environments = [...new Set(files.map((file) => file.environment))].sort();
  const plans = [];

  for (const environment of environments) {
    const head = await fetchHead(projectId, environment);
    const plan = { environment, head, files: [], changes: 0, encrypt: 0, stale: false };

    for (const file of files.filter((item) => item.environment === environment)) {
      const headFile = head?.files.find((item) => item.service === file.service);
      const items = [];
      const changes = [];
      const skipped = [];
      const seen = new Set();

      for (const existing of headFile?.entries || []) {
        if (!existing.name) {
          items.push({ ref: existing.id });
          continue;
        }
        seen.add(existing.name);
        if (!file.values.has(existing.name)) {
          if (canDecrypt(existing)) changes.push({ key: existing.name, op: "removed" });
          else items.push({ ref: existing.id, name: existing.name });
          continue;
        }
        const value = file.values.get(existing.name);
        if (!canDecrypt(existing)) {
          items.push({ ref: existing.id, name: existing.name });
          skipped.push(existing.name);
          continue;
        }
        const same = cachedMatches(cache, file, existing.name, value, existing.id, identity.cacheKey) || decryptAt(existing, identity.privateKey, { projectId, environment, service: file.service }) === value;
        if (same) items.push({ ref: existing.id, name: existing.name, value });
        else {
          items.push({ name: existing.name, value, rev: existing.rev + 1 });
          changes.push({ key: existing.name, op: "modified" });
        }
      }
      for (const [name, value] of file.values) {
        if (seen.has(name)) continue;
        items.push({ name, value, rev: 1 });
        changes.push({ key: name, op: "added" });
      }

      changes.sort((a, b) => a.key.localeCompare(b.key));
      plan.files.push({ file, items, changes, skipped, isNew: !headFile });
      plan.changes += changes.length;
      plan.encrypt += items.filter((item) => !item.ref).length;
    }

    // Remote moved since this machine last synced the environment.
    const known = cache.envs[environment];
    plan.stale = Boolean(head && plan.changes && known !== head.id && !force);
    plans.push(plan);
  }
  return plans;
};

// Encrypts what changed and uploads one version for the environment, signed
// by this device when it can sign (signer from signing.writer).
export const executePush = async ({ projectId, plan, readers, isProtected, message, cache, identity, signer = null }) => {
  const payload = [];
  const synced = [];
  let waiting = new Set();

  for (const { file, items, changes } of plan.files) {
    if (!changes.length) {
      synced.push({ file, entries: items.filter((item) => item.value !== undefined).map((item) => ({ name: item.name, value: item.value, entryId: item.ref })) });
      continue;
    }
    const entries = [];
    const records = [];
    for (const item of items) {
      if (item.ref) {
        entries.push({ ref: item.ref });
        if (item.value !== undefined) records.push({ name: item.name, value: item.value, entryId: item.ref });
        continue;
      }
      const entry = signNewEntry(encryptEntry({ projectId, environment: plan.environment, service: file.service, name: item.name, value: item.value, rev: item.rev, readers, isProtected }), { projectId, environment: plan.environment, service: file.service }, signer);
      for (const person of waitingFor(readers, { env: plan.environment, service: file.service, key: item.name, protected: isProtected })) waiting.add(person.login);
      entries.push(entry);
      records.push({ name: item.name, value: item.value, entryId: entry.id });
    }
    payload.push({ service: file.service, path: file.path, entries });
    synced.push({ file, entries: records });
  }

  const id = newVersionId();
  const parent = plan.head?.id || null;
  const result = await api.createVersion(projectId, plan.environment, {
    id,
    parent,
    message,
    kind: "push",
    clientVersion: CLIENT_VERSION,
    files: payload,
    ...signNewVersion({ id, parent, projectId, environment: plan.environment, kind: "push", head: plan.head, files: payload }, signer),
  });

  for (const item of synced) recordFile(cache, item.file, item.entries, identity.cacheKey);
  recordEnvironment(cache, plan.environment, result.version.id);
  return { version: result.version, unchanged: result.unchanged, waiting: [...waiting] };
};

// Decrypts one remote file into values, counting what the user can't read.
// where: { projectId, environment } this client asked for. Every name in
// the file is checked first, so a bad name stops the whole read before any
// value is decrypted, written or run; every entry must carry the AAD of
// that place.
export const decryptFile = (remoteFile, identity, where) => {
  if (!where?.projectId || !where?.environment) throw new StoreEnvError("SE_INTEGRITY", "A file was read without its expected project and environment.");
  const location = { projectId: where.projectId, environment: where.environment, service: remoteFile.service };
  assertSafeEnvNames(remoteFile.entries.filter((entry) => !entry.hidden).map((entry) => entry.name));
  const entries = [];
  let notShared = 0;
  let pending = 0;
  const hiddenNames = [];
  for (const entry of remoteFile.entries) {
    if (!entry.shared) {
      notShared += 1;
      if (entry.name) hiddenNames.push(entry.name);
      continue;
    }
    if (!entry.wrappedEsk) {
      pending += 1;
      hiddenNames.push(entry.name);
      continue;
    }
    assertEntryLocation(entry, location);
    entries.push({ name: entry.name, value: decryptEntry(entry, identity.privateKey), entryId: entry.id });
  }
  return { entries, notShared, pending, hiddenNames, total: remoteFile.entries.length };
};

// Works out what pulling one file would do to the copy on disk.
export const planPullFile = ({ root, remoteFile, projectId, environment, cache, identity }) => {
  const file = { path: remoteFile.path, service: remoteFile.service, environment };
  const remote = decryptFile(remoteFile, identity, { projectId, environment });
  const target = path.join(root, remoteFile.path);
  let local = null;
  let localChanges = [];

  if (exists(target)) {
    const parsed = parseEnv(readEnv(target));
    local = { ...file, values: new Map(parsed.entries.map((entry) => [entry.key, entry.value])) };
    const remoteMap = new Map(remote.entries.map((entry) => [entry.name, entry.value]));
    const hidden = new Set(remote.hiddenNames);
    const diff = diffAgainstCache(cache, local, identity.cacheKey);
    // Without a cache every difference from the remote counts as a local edit.
    const candidates = diff.known
      ? diff.changes
      : [...local.values.keys()].filter((key) => remoteMap.get(key) !== local.values.get(key)).map((key) => ({ key, op: remoteMap.has(key) ? "modified" : "added" }));
    localChanges = candidates.filter((change) => {
      if (hidden.has(change.key)) return false;
      if (change.op === "removed") return remoteMap.has(change.key);
      return remoteMap.get(change.key) !== local.values.get(change.key);
    });
  }

  // Keys that exist remotely but are not shared with this user stay as they
  // are on disk.
  const preserved = [];
  if (local) {
    const names = new Set(remote.entries.map((entry) => entry.name));
    for (const name of remote.hiddenNames) {
      if (!names.has(name) && local.values.has(name)) preserved.push({ key: name, value: local.values.get(name) });
    }
  }

  const upToDate = Boolean(local) && !localChanges.length && remote.entries.length + preserved.length === local.values.size &&
    remote.entries.every((entry) => local.values.get(entry.name) === entry.value);

  return { file, remote, local, localChanges, preserved, upToDate, exists: Boolean(local) };
};

export const renderPulledFile = (plan) =>
  serializeEnv([
    ...plan.remote.entries.map((entry) => ({ key: entry.name, value: entry.value })),
    ...plan.preserved,
  ]);

export const recordPulledFile = (cache, plan, identity) => {
  recordFile(cache, plan.file, plan.remote.entries, identity.cacheKey);
};
