// Which public keys this CLI is willing to encrypt for.
//
// The server lists each project's readers with their public keys. A server
// that lies (compromised, or run by someone hostile) could add its own key
// or swap a teammate's. Two independent checks stop that:
//
// 1. The key transparency log (packages/core transparency.js). Every key the
//    server hands out must be that person's latest leaf in a tree head
//    signed by the pinned log key, and every new head must be consistent
//    with the last one this device saw. A key slipped in outside the log, or
//    a rewritten history, fails here: SE_KEY_MISMATCH or
//    SE_KEY_LOG_INCONSISTENT.
// 2. Local pins in ~/.storeenv/known_keys, like SSH's known_hosts. A key is
//    "verified" once its fingerprint was compared with the person through
//    another channel (storeenv verify), or "approved" once you confirmed it
//    when it first appeared. A logged key that differs from your pin is a
//    real rotation and needs re-verification: SE_KEY_ROTATION_REQUIRED.
//    Readers never seen before need a decision: SE_KEY_NOT_VERIFIED when
//    nobody can be asked.
//
// CI: pre-provide fingerprints with STOREENV_TRUSTED_KEYS="@ana=SE:...,@bo=SE:..."
// and the log key with STOREENV_LOG_KEY. Nothing skips verification.

import path from "node:path";
import fs from "node:fs";
import {
  StoreEnvError, classifyReaders, fingerprintOf, parseTrustedKeys, sameFingerprint, verifyLeaves, verifyLogUpdate,
} from "@storeenv/core";
import { api } from "./api.js";
import { apiBase, homeDir, readConfig, readJson, writePrivateFile } from "./config.js";
import { bold, dim, line, warn } from "./output.js";
import { confirm, isInteractive } from "./prompt.js";

const storePath = () => path.join(homeDir(), "known_keys");
const legacyPath = () => path.join(homeDir(), "known-keys.json");

// Pins belong to one identity on one server.
const scope = (identity) => `${apiBase()} ${identity.fingerprint}`;

// { version: 1, servers: { [scope]: { log: {...}, keys: { [userId]: record } } } }
const readStore = () => {
  const store = readJson(storePath(), null);
  if (store?.version === 1) return store;
  // The first format: { [scope]: { [userId]: { login, publicKey, fingerprint, approvedAt } } }
  const legacy = readJson(legacyPath(), null) || {};
  const servers = {};
  for (const [key, people] of Object.entries(legacy)) {
    servers[key] = { keys: {} };
    for (const [userId, item] of Object.entries(people || {})) {
      servers[key].keys[userId] = { userId, login: item.login, publicKey: item.publicKey, fingerprint: item.fingerprint, status: "approved", keyVersion: null, firstVerifiedAt: item.approvedAt, lastVerifiedAt: item.approvedAt };
    }
  }
  return { version: 1, servers };
};

const writeStore = (store) => {
  writePrivateFile(storePath(), `${JSON.stringify(store, null, 2)}\n`);
  fs.rmSync(legacyPath(), { force: true });
};

const section = (store, identity) => (store.servers[scope(identity)] ||= { keys: {} });

export const knownKeys = (identity) => section(readStore(), identity).keys;

export const pinKey = (identity, { userId, login, publicKey, status, keyVersion }) => {
  const store = readStore();
  const keys = section(store, identity).keys;
  const now = new Date().toISOString();
  const previous = keys[userId]?.publicKey === publicKey ? keys[userId] : null;
  keys[userId] = {
    userId, login, publicKey, fingerprint: fingerprintOf(publicKey),
    status: previous?.status === "verified" && status !== "verified" ? "verified" : status,
    keyVersion: keyVersion ?? previous?.keyVersion ?? null,
    firstVerifiedAt: previous?.firstVerifiedAt || now,
    lastVerifiedAt: now,
  };
  writeStore(store);
  return keys[userId];
};

export const forgetKey = (identity, userId) => {
  const store = readStore();
  delete section(store, identity).keys[userId];
  writeStore(store);
};

// Checks the signed head against the pinned log key and the last head this
// device saw, then the inclusion proof of each requested user's latest key.
// Returns Map(userId -> leaf). Throws SE_KEY_LOG_INCONSISTENT on any failure.
export const checkLog = async (identity, userIds, { quiet = false } = {}) => {
  const head = await api.logHead();
  const store = readStore();
  const server = section(store, identity);
  const { firstUse, state } = await verifyLogUpdate({ head, pinned: server.log || null, presetLogKey: process.env.STOREENV_LOG_KEY || null, fetchConsistency: (from, to) => api.logConsistency(from, to) });
  const ids = [...new Set(userIds)];
  const leaves = ids.length ? verifyLeaves(head, (await api.logKeys(ids, head.size)).keys) : new Map();
  if (firstUse && !quiet) line(dim(`Pinned the server's key log ${head.logKeyId}. Compare it with a teammate's "storeenv verify --head" once.`));
  server.log = state;
  writeStore(store);
  return { head, leaves };
};

export { sameFingerprint };

// Vets the people a secret is about to be encrypted for.
// mode "ask": new readers are listed for one confirmation, or refused with
//   SE_KEY_NOT_VERIFIED when nobody can be asked.
// mode "skip": new readers are left out (their share waits) without asking.
// Returns the people, with publicKey cleared for anyone left out.
export const vetPeople = async (identity, people, { mode = "ask", quiet = false } = {}) => {
  const withKeys = people.filter((person) => person.publicKey);
  const { leaves } = await checkLog(identity, withKeys.map((person) => person.userId), { quiet });
  const { trusted, fresh, provisionedPins } = classifyReaders({
    people: withKeys,
    leaves,
    pins: knownKeys(identity),
    self: { publicKey: identity.publicKeyBase64, login: readConfig().login },
    provisioned: parseTrustedKeys(process.env.STOREENV_TRUSTED_KEYS),
  });
  for (const person of provisionedPins) pinKey(identity, { userId: person.userId, login: person.login, publicKey: person.publicKey, status: "verified", keyVersion: person.keyVersion });
  const result = new Map(trusted.map((person) => [person.userId, person]));

  if (fresh.length) {
    let approved = false;
    if (mode === "ask" && isInteractive()) {
      line("");
      line(`${fresh.length} new ${fresh.length === 1 ? "reader" : "readers"} will receive access:`);
      line("");
      for (const person of fresh) line(`  ${bold(`@${person.login}`)} — ${person.fingerprint}`);
      line("");
      line(dim("Approve only if each person read you the same fingerprint (storeenv whoami)."));
      approved = await confirm("Continue?", false);
      if (!approved) throw new StoreEnvError("SE_KEY_NOT_VERIFIED", "Nothing was encrypted: new readers were not approved.");
    } else if (mode === "ask") {
      throw new StoreEnvError("SE_KEY_NOT_VERIFIED", `Not verified on this device: ${fresh.map((person) => `@${person.login} ${person.fingerprint}`).join(", ")}.`, {
        hint: `Compare fingerprints, then storeenv verify ${fresh.map((person) => `@${person.login}`).join(" ")} (or set STOREENV_TRUSTED_KEYS in CI). To push for verified readers only, add --skip-unverified`,
      });
    }
    for (const person of fresh) {
      if (approved) {
        pinKey(identity, { userId: person.userId, login: person.login, publicKey: person.publicKey, status: "approved", keyVersion: person.keyVersion });
        result.set(person.userId, person);
      } else {
        if (!quiet) warn(`Not encrypting for @${person.login} until their key is verified: storeenv verify @${person.login} ${person.fingerprint}`);
        result.set(person.userId, { ...person, publicKey: null, untrusted: true });
      }
    }
  }
  return people.map((person) => result.get(person.userId) || person);
};
