// Key sharing and re-keying. The server can't do either: it never sees an
// ESK. An unlocked client that can read the secrets has to.

import { newVersionId } from "@storeenv/core";
import { CLIENT_VERSION, api } from "./api.js";
import { decryptAt, encryptEntry, rewrapEsk } from "./crypto.js";
import { signNewEntry, signNewVersion, verifyVersion, writer } from "./signing.js";
import { vetPeople } from "./trust.js";

// Wraps ESKs for members who are allowed in but can't decrypt yet.
export const sharePending = async (projectId, identity, { mode = "ask", quiet = false } = {}) => {
  const { pending } = await api.pendingShares(projectId);
  const shares = [];
  const people = [];
  const waiting = [];
  // Only people whose keys this CLI has approved get key shares.
  const vetted = await vetPeople(identity, pending.filter((person) => !person.self && person.hasIdentity && person.shareable.length), { mode, quiet });
  const byUser = new Map(vetted.map((person) => [person.userId, person]));
  for (const original of pending) {
    const person = byUser.get(original.userId) || original;
    if (person.self) continue;
    if (person.untrusted) {
      waiting.push({ login: person.login, reason: "their key isn't verified on this device yet" });
      continue;
    }
    if (!person.hasIdentity) {
      waiting.push({ login: person.login, reason: "has not set up a key yet" });
      continue;
    }
    if (!person.shareable.length) {
      if (person.total) waiting.push({ login: person.login, reason: "needs keys you can't read" });
      continue;
    }
    for (const item of person.shareable) {
      shares.push({
        entryId: item.entryId,
        userId: person.userId,
        fingerprint: person.fingerprint,
        wrappedEsk: rewrapEsk(item.wrappedEsk, identity.privateKey, item.aad, person.publicKey),
      });
    }
    people.push({ login: person.login, secrets: person.shareable.length, remaining: person.total - person.shareable.length, fingerprint: person.fingerprint });
  }
  if (shares.length) await api.uploadShares(projectId, shares);
  return { shared: shares.length, people, waiting };
};

export const countPending = async (projectId) => {
  const { pending } = await api.pendingShares(projectId);
  return pending.filter((person) => !person.self && person.shareable.length);
};

// New ESKs for every secret a removed member could read. One version of
// kind "rekey" per environment.
// policy: the read policy of the command (signing.readPolicy); each head is
// verified before its values are re-encrypted, so a forged value can't come
// out of a rekey signed by this device.
export const rekeyPending = async (projectId, identity, { mode = "ask", policy = null } = {}) => {
  const { tasks, entries } = await api.rekeyTasks(projectId);
  if (!tasks.length) return { tasks: [], versions: [], secrets: [], blocked: [] };
  const listed = await api.readers(projectId);
  const environments = listed.environments;
  const readers = await vetPeople(identity, listed.readers, { mode });
  const versions = [];
  const secrets = [];
  const blocked = entries.filter((entry) => !entry.canRekey);
  const label = [...new Set(tasks.map((task) => task.login))].map((login) => `@${login}`).join(", ");

  for (const environment of [...new Set(entries.filter((entry) => entry.canRekey).map((entry) => entry.env))]) {
    const { version } = await api.head(projectId, environment);
    // Values that arrive unsigned are re-encrypted but stay unsigned: a rekey
    // must never turn an unverified value into one this device vouches for.
    const checked = policy ? await verifyVersion(version, { projectId, environment }, { ...policy, policy: "pull", allowUnsigned: true }) : { unsigned: [], revoked: [] };
    const unsigned = new Set([...checked.unsigned, ...checked.revoked].map(({ entry }) => entry.id));
    const signer = policy ? await writer(identity, policy.user) : null;
    const isProtected = Boolean(environments.find((item) => item.name === environment)?.protected);
    const targets = new Set(entries.filter((entry) => entry.env === environment && entry.canRekey).map((entry) => entry.id));
    const files = version.files.map((file) => ({
      service: file.service,
      path: file.path,
      entries: file.entries.map((entry) => {
        if (!targets.has(entry.id) || !entry.wrappedEsk) return { ref: entry.id };
        secrets.push({ environment, service: file.service, name: entry.name });
        return signNewEntry(encryptEntry({
          projectId, environment, service: file.service, name: entry.name, value: decryptAt(entry, identity.privateKey, { projectId, environment, service: file.service }),
          rev: entry.rev + 1, readers, isProtected, rekeyOf: entry.id,
        }), { projectId, environment, service: file.service }, unsigned.has(entry.id) ? null : signer);
      }),
    }));
    const id = newVersionId();
    const result = await api.createVersion(projectId, environment, {
      id, parent: version.id, kind: "rekey", message: `Re-key after removing ${label}`, clientVersion: CLIENT_VERSION, files,
      ...signNewVersion({ id, parent: version.id, projectId, environment, kind: "rekey", head: version, files }, signer),
    });
    versions.push(result.version);
  }
  return { tasks, versions, secrets, blocked, readers: readers.filter((reader) => reader.publicKey).length };
};
