// Writer signatures in the CLI.
//
// Reading: before any value is exposed (run, pull, copy, diff --reveal,
// rekey, sign), the version and every readable entry are checked:
//   1. a fresh key log head (signed, consistent with the pinned head, at
//      most one hour old) and a complete copy of the log that matches it;
//   2. the signer's device chain, replayed from that log: certified by the
//      account key or by a current device, nothing in the chain revoked;
//   3. the signatures themselves, rebuilt from the project and environment
//      this client asked for;
//   4. the writer is trusted for the project: this account, a writer listed
//      in the repository's .storeenv.json, one approved on this device, or
//      one passed with --trust-writer. A valid signature alone is not
//      enough: a hostile server can invent an account and sign with it.
//
// Writing: every new entry and version is signed with this device's key.

import fs from "node:fs";
import path from "node:path";
import {
  StoreEnvError, assertSafeEnvNames, certifyDevice, checkLogFreshness, deriveIdentity, checkVersionManifest, composeManifest, deriveAccountSigningKey, deviceSigningKeyFrom,
  deviceStateFromLog, fingerprintOf, generateDeviceSigningKey, revokeDevice, sameFingerprint, signAccountBinding, signEntry, signVersion,
  signingKeyId, verifyCompleteLog, verifyEntrySignature, verifyVersionSignature,
} from "@storeenv/core";
import { api } from "./api.js";
import { apiBase, homeDir, readConfig, readJson, writePrivateFile } from "./config.js";
import { loadSigningKey, storeSigningKey } from "./keyring.js";
import { bold, dim, line, warn } from "./output.js";
import { confirm, isInteractive } from "./prompt.js";
import { checkLog, knownKeys } from "./trust.js";
import { unsignedConsent } from "./consent.js";

// ---- Local state ---------------------------------------------------------------
// ~/.storeenv/signing.json, per server and identity: approved writers per
// project, projects seen signed, and recently verified heads.

const statePath = () => path.join(homeDir(), "signing.json");
const scope = (identity) => `${apiBase()} ${identity.fingerprint}`;
const readState = () => readJson(statePath(), null) || { version: 1, servers: {} };
const section = (store, identity) => (store.servers[scope(identity)] ||= { writers: {}, signed: {}, heads: {} });
const updateState = (identity, change) => {
  const store = readState();
  change(section(store, identity));
  writePrivateFile(statePath(), `${JSON.stringify(store, null, 2)}\n`);
};

export const approvedWriters = (identity, projectId) => section(readState(), identity).writers[projectId] || {};

export const approveWriter = (identity, projectId, { userId, login, fingerprint }) =>
  updateState(identity, (server) => {
    (server.writers[projectId] ||= {})[userId] = { login, fingerprint, approvedAt: new Date().toISOString() };
  });

export const forgetWriter = (identity, projectId, login) =>
  updateState(identity, (server) => {
    for (const [userId, item] of Object.entries(server.writers[projectId] || {})) if (item.login === login) delete server.writers[projectId][userId];
  });

// ---- The complete key log --------------------------------------------------------
// Cached per log key; every use rechecks the whole copy against the head.

const logCachePath = (head) => path.join(homeDir(), "keylog", `${head.logKeyId.replace(/[^A-Z0-9]/gi, "")}.json`);

export const syncLog = async (identity) => {
  const { head } = await checkLog(identity, [], { quiet: true });
  checkLogFreshness(head);
  const file = logCachePath(head);
  let leaves = readJson(file, null)?.leaves || [];
  if (leaves.length > head.size) leaves = [];
  const fetchFrom = async (start) => {
    const out = [];
    for (let from = start; from < head.size; ) {
      const page = (await api.logLeaves(from, head.size)).leaves;
      if (!page.length) break;
      out.push(...page);
      from += page.length;
    }
    return out;
  };
  let all = [...leaves, ...(await fetchFrom(leaves.length))];
  if (!verifyCompleteLog(head, all)) all = await fetchFrom(0);
  if (!verifyCompleteLog(head, all)) {
    throw new StoreEnvError("SE_KEY_LOG_INCONSISTENT", "The key log entries the server sent don't match its signed head. Nothing was written or run.");
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writePrivateFile(file, JSON.stringify({ size: head.size, leaves: all }));
  return { head, leaves: all };
};

export const accountState = (leaves, userId) => deviceStateFromLog(leaves.filter((leaf) => leaf.userId === userId), userId);

// ---- This device's signing key ------------------------------------------------------

export const deviceKey = () => {
  const privateKey = loadSigningKey();
  return privateKey ? deviceSigningKeyFrom(privateKey) : null;
};

// A key for this device, made if missing. Certification is separate.
export const ensureDeviceKey = () => {
  const existing = deviceKey();
  if (existing) return existing;
  const fresh = generateDeviceSigningKey();
  storeSigningKey(fresh.privateKey);
  return fresh;
};

// The device key if the log says it can sign for this account now.
export const certifiedDeviceKey = async (identity, userId) => {
  const key = deviceKey();
  if (!key) return null;
  const { leaves } = await syncLog(identity);
  return accountState(leaves, userId).devices.has(key.publicKeyBase64) ? key : null;
};

// Uses the recovery phrase once: registers the account key if the log has
// none for this identity, then certifies this device with it. The phrase
// and the account key are dropped after.
export const setupWithPhrase = async (identity, user, phrase, { deviceName } = {}) => {
  // The phrase must be this identity's: another phrase would bind a foreign
  // account key to this account.
  if (deriveIdentity(phrase).publicKeyBase64 !== identity.publicKeyBase64) {
    throw new StoreEnvError("SE_FINGERPRINT_MISMATCH", "This phrase belongs to a different identity. Nothing was set up.");
  }
  const ask = deriveAccountSigningKey(phrase);
  try {
    const { leaves } = await syncLog(identity);
    let state = accountState(leaves, user.id);
    if (!state.accountKey) {
      await api.signingEvent("signing.registered", signAccountBinding({ userId: user.id, publicKey: identity.publicKeyBase64 }, ask, identity.privateKey));
    } else if (state.accountKey !== ask.publicKeyBase64) {
      throw new StoreEnvError("SE_KEY_MISMATCH", "The account signing key in the log isn't the one this phrase gives.", { hint: "Check that this is the phrase of your current identity" });
    }
    const key = ensureDeviceKey();
    state = accountState((await syncLog(identity)).leaves, user.id);
    if (!state.devices.has(key.publicKeyBase64)) {
      const cert = certifyDevice({ userId: user.id, accountKey: ask.publicKeyBase64, deviceKey: key.publicKeyBase64, deviceName: deviceName || null }, ask);
      await api.signingEvent("device.added", cert, { thisDevice: true });
    }
    return key;
  } finally {
    ask.privateKey.fill(0);
  }
};

// Certifies another device of this account with this device's key.
export const certifyOther = async (identity, user, { deviceKey: other, deviceName }) => {
  const key = await certifiedDeviceKey(identity, user.id);
  if (!key) return null;
  const state = accountState((await syncLog(identity)).leaves, user.id);
  return certifyDevice({ userId: user.id, accountKey: state.accountKey, deviceKey: other, deviceName: deviceName || null }, key);
};

// Revokes a device's signing key (and every device it certified).
export const revokeOther = async (identity, user, signingKey) => {
  const key = await certifiedDeviceKey(identity, user.id);
  if (!key) throw new StoreEnvError("SE_UNSIGNED", "This device can't sign, so it can't revoke another device's signing key.", { hint: "Run storeenv keys signing-setup (needs your recovery phrase), or revoke from a device that signs" });
  const state = accountState((await syncLog(identity)).leaves, user.id);
  await api.signingEvent("device.revoked", revokeDevice({ userId: user.id, accountKey: state.accountKey, deviceKey: signingKey }, key));
};

// ---- Signing writes ----------------------------------------------------------------

export const signNewEntry = (entry, where, signer) => (signer ? signEntry(entry, { ...where, userId: signer.userId }, signer.key) : entry);

export const signNewVersion = ({ id, parent, projectId, environment, kind, head, files, removeFiles }, signer) => {
  if (!signer) return {};
  const manifest = composeManifest({ head, files, removeFiles });
  return signVersion({ id, parent, projectId, environment, kind, manifest }, { userId: signer.userId }, signer.key);
};

export const signRollback = ({ id, parent, projectId, environment, manifest }, signer) =>
  signer ? signVersion({ id, parent, projectId, environment, kind: "rollback", manifest }, { userId: signer.userId }, signer.key) : {};

// Who signs this process's writes, or null (older setup: the write goes up
// unsigned, with a warning, and readers will treat it as unverified).
let signerWarned = false;
export const writer = async (identity, user) => {
  const key = await certifiedDeviceKey(identity, user.id).catch(() => null);
  if (key) return { key, userId: user.id };
  if (!signerWarned) {
    signerWarned = true;
    warn("This device can't sign yet, so this write is unsigned and other clients will treat it as unverified. Set it up once: storeenv keys signing-setup");
  }
  return null;
};

// ---- Verifying reads -------------------------------------------------------------------

// The repository's own list of writers: "writers": ["@ana=SE:XXXX-XXXX-XXXX"].
const repoWriters = (settings) => {
  const out = new Map();
  for (const item of settings?.writers || []) {
    const [login, fingerprint] = String(item).split("=").map((part) => part?.trim());
    if (login && fingerprint) out.set(login.replace(/^@/, "").toLowerCase(), fingerprint);
  }
  return out;
};

const flagWriters = (list = []) => {
  const out = new Map();
  for (const item of list.flatMap((value) => String(value).split(","))) {
    const [login, fingerprint] = item.split("=").map((part) => part?.trim());
    if (login) out.set(login.replace(/^@/, "").toLowerCase(), fingerprint || null);
  }
  return out;
};

const describeWriter = (state, leaf) => ({ userId: state.userId, login: leaf?.login || state.userId, fingerprint: state.publicKey ? fingerprintOf(state.publicKey) : null });

// Checks one version for the place this client asked for, before any of
// its values is used. Returns { signed, unsigned, revoked, writers } where
// unsigned and revoked list the readable entries (with service) that have no
// writer signature or were signed by a device revoked since. Throws on
// anything forged.
// options: { identity, user, settings, policy, trustWriters, allowUnsigned,
//   pinned, entriesOnly, collect }
//   policy "run" refuses unsigned and revoked; "source" (copy) the same;
//   "pull" warns about unsigned and refuses revoked; "compose" (building a
//   push on a head) checks signatures and signers only; collect (sign)
//   returns unsigned and revoked instead of refusing.
export const verifyVersion = async (version, { projectId, environment }, options) => {
  const { identity, user, settings = {}, policy = "pull", collect = false } = options;
  // A copy signs what it takes, and run hands values to a program: an
  // unverified value must never reach either, so --allow-unsigned applies to
  // neither (it only lets pull and diff show what an older client wrote).
  const allowUnsigned = policy === "source" || policy === "run" ? false : Boolean(options.allowUnsigned);
  const { leaves } = await syncLog(identity);
  const states = new Map();
  const stateOf = (userId) => {
    if (!states.has(userId)) states.set(userId, accountState(leaves, userId));
    return states.get(userId);
  };
  const lastLeaf = (userId) => [...leaves].reverse().find((leaf) => leaf.userId === userId);
  const place = { projectId, environment };
  const exposed = version.files.flatMap((file) => file.entries.filter((entry) => entry.shared && entry.wrappedEsk).map((entry) => ({ entry, service: file.service })));
  // Names first: nothing below may print a name that could carry control
  // characters or new lines.
  assertSafeEnvNames(version.files.flatMap((file) => file.entries.filter((entry) => !entry.hidden).map((entry) => entry.name)));
  const writers = new Map();
  const unsigned = [];
  const revoked = [];

  // A signer is current, or was revoked (its earlier values are then
  // unverified), or never was a certified device (forged: refused).
  const signerStatus = (userId, key) => {
    const state = stateOf(userId);
    if (state.devices.has(key)) return { state, ok: true };
    if (state.revoked.has(key)) return { state, ok: false };
    throw new StoreEnvError("SE_SIGNATURE", `A value is signed by ${signingKeyId(key)}, which was never a certified device of its account. Nothing was written or run.`);
  };

  let versionOk = false;
  if (!options.entriesOnly && version.signature) {
    const claimed = { ...version, projectId, environment };
    if (!verifyVersionSignature(claimed) || !checkVersionManifest(claimed, version.files, version.hiddenFiles)) {
      throw new StoreEnvError("SE_SIGNATURE", `The version ${String(version.id).slice(0, 7)} of ${environment} doesn't match its writer's signature. Nothing was written or run.`);
    }
    const status = signerStatus(version.signerUserId, version.signerKey);
    versionOk = status.ok;
    if (status.ok) writers.set(version.signerUserId, status.state);
  }

  for (const item of exposed) {
    const { entry, service } = item;
    if (!entry.signature) {
      unsigned.push(item);
      continue;
    }
    if (!verifyEntrySignature(entry, { ...place, service })) {
      throw new StoreEnvError("SE_SIGNATURE", `${entry.name} in ${environment}/${service} doesn't match its writer's signature. Nothing was written or run.`);
    }
    const status = signerStatus(entry.signerUserId, entry.signerKey);
    if (!status.ok) revoked.push(item);
    else writers.set(entry.signerUserId, status.state);
  }
  // Without a valid version signature every value counts as unsigned: the
  // set of values, their files and paths aren't vouched for.
  if (!options.entriesOnly && !versionOk) {
    for (const item of exposed) if (!unsigned.includes(item) && !revoked.includes(item)) unsigned.push(item);
  }
  const names = (list) => [...new Set(list.map(({ entry }) => entry.name))].join(", ");

  if (policy === "compose" || collect) return { signed: versionOk && !unsigned.length && !revoked.length, unsigned, revoked, writers: [...writers.keys()] };

  // --allow-unsigned overriding a refusal needs a person's consent (R10).
  // Only the user's flag asks (readPolicy); internal re-keying doesn't.
  if (revoked.length && allowUnsigned && options.confirmUnsigned) await unsignedConsent(names(revoked));
  if (revoked.length && !allowUnsigned) {
    throw new StoreEnvError("SE_SIGNATURE", `${names(revoked)} ${revoked.length === 1 ? "was" : "were"} signed by a device that has since been revoked. Nothing was written or run.`, { hint: "A writer you trust can check and re-sign them: storeenv sign" });
  }

  // Projects seen signed stay signed: an unsigned head afterwards is refused.
  const key = `${projectId} ${environment}`;
  const seenSigned = section(readState(), identity).signed[key];
  if (unsigned.length) {
    if (seenSigned && allowUnsigned && options.confirmUnsigned && !options.entriesOnly && !options.pinned) await unsignedConsent(names(unsigned));
    if (seenSigned && !allowUnsigned && !options.entriesOnly && !options.pinned) {
      throw new StoreEnvError("SE_UNSIGNED", `${environment} was signed when this device last read it, and now ${names(unsigned)} ${unsigned.length === 1 ? "isn't" : "aren't"}. Nothing was written or run.`, { hint: "Someone may be replaying old data. If a writer really pushed with an old client, ask them to run storeenv sign" });
    }
    if (policy === "run" || policy === "source") {
      if (!allowUnsigned) {
        throw new StoreEnvError("SE_UNSIGNED", `${names(unsigned)} ${unsigned.length === 1 ? "isn't" : "aren't"} signed by ${unsigned.length === 1 ? "its" : "their"} writer, so StoreEnv can't tell ${unsigned.length === 1 ? "it" : "them"} from a forgery. Nothing was ${policy === "run" ? "run" : "copied"}.`, {
          hint: "A writer you trust can check and sign them with storeenv sign",
        });
      }
    } else {
      warn(`Unverified: ${names(unsigned)} ${unsigned.length === 1 ? "isn't" : "aren't"} signed by ${unsigned.length === 1 ? "its" : "their"} writer. storeenv run refuses unsigned values; a writer can fix this with storeenv sign.`);
    }
  }
  if ((unsigned.length || revoked.length) && allowUnsigned) process.stderr.write(`storeenv: using UNVERIFIED values (--allow-unsigned): ${names([...unsigned, ...revoked])}\n`);

  // Trust matters only for values this device is about to use.
  if (exposed.length) await checkWriterTrust({ identity, user, settings, policy, projectId, writers, lastLeaf, trustWriters: options.trustWriters });

  // A head this device already moved past can't come back as the head:
  // that would be the server replaying an older genuine version.
  const seen = section(readState(), identity).heads[key];
  if (!options.pinned && !options.entriesOnly && seen && seen.latest !== version.id && seen.ids.includes(version.id)) {
    throw new StoreEnvError("SE_INTEGRITY", `The server returned ${String(version.id).slice(0, 7)} as the latest ${environment}, but this device already saw a newer version. Nothing was written or run.`, { hint: "Report this to whoever runs your StoreEnv server" });
  }
  updateState(identity, (server) => {
    if (versionOk && !unsigned.length && !revoked.length) server.signed[key] = true;
    if (!options.pinned && !options.entriesOnly) {
      const heads = (server.heads[key] ||= { latest: null, ids: [] });
      heads.latest = version.id;
      if (!heads.ids.includes(version.id)) heads.ids = [...heads.ids, version.id].slice(-200);
    }
  });
  return { signed: versionOk && !unsigned.length && !revoked.length, unsigned, revoked, writers: [...writers.keys()] };
};

// Writer trust: this account, the repository's list, this device's
// approvals, or --trust-writer. Unknown writers are asked about when a
// person is there (never for run), and refused otherwise.
const checkWriterTrust = async ({ identity, user, settings, policy, projectId, writers, lastLeaf, trustWriters }) => {
  const fromRepo = repoWriters(settings);
  const fromFlags = flagWriters(trustWriters);
  const approved = approvedWriters(identity, projectId);
  // People whose fingerprint was checked out of band (storeenv verify, or
  // STOREENV_TRUSTED_KEYS) are trusted writers too, for every project.
  const verified = knownKeys(identity);
  const unknown = [];
  for (const [userId, state] of writers) {
    if (userId === user.id && state.publicKey === identity.publicKeyBase64) continue;
    const who = describeWriter(state, lastLeaf(userId));
    const pin = approved[userId];
    if (pin && sameFingerprint(pin.fingerprint, who.fingerprint)) continue;
    if (verified[userId]?.status === "verified" && verified[userId].publicKey === state.publicKey) continue;
    const listed = fromRepo.get(who.login.toLowerCase()) ?? null;
    if (listed && sameFingerprint(listed, who.fingerprint)) continue;
    if (listed) throw new StoreEnvError("SE_UNKNOWN_WRITER", `.storeenv.json trusts @${who.login} as ${listed}, but their key is now ${who.fingerprint}. Nothing was written or run.`, { hint: "Confirm the new fingerprint with them, then update .storeenv.json" });
    if (fromFlags.has(who.login.toLowerCase())) {
      const given = fromFlags.get(who.login.toLowerCase());
      if (given && !sameFingerprint(given, who.fingerprint)) throw new StoreEnvError("SE_UNKNOWN_WRITER", `--trust-writer says @${who.login} is ${given}, but their key is ${who.fingerprint}.`);
      continue;
    }
    unknown.push(who);
  }
  if (!unknown.length) return;
  let approve = false;
  if (policy !== "run" && isInteractive()) {
    line("");
    line(`${unknown.length === 1 ? "A writer" : "Writers"} this device hasn't trusted for this project yet:`);
    for (const who of unknown) line(`  ${bold(`@${who.login}`)}  ${who.fingerprint}`);
    line(dim("Trust only if each person read you the same fingerprint (storeenv whoami)."));
    approve = await confirm("Trust and continue?", false);
  }
  if (!approve) {
    throw new StoreEnvError("SE_UNKNOWN_WRITER", `Values were written by ${unknown.map((who) => `@${who.login} ${who.fingerprint}`).join(", ")}, who ${unknown.length === 1 ? "isn't" : "aren't"} trusted as a writer on this device. Nothing was written or run.`, {
      hint: `Compare fingerprints, then: storeenv trust writer ${unknown.map((who) => `@${who.login} ${who.fingerprint}`).join(" ")} (or list them in .storeenv.json writers, or pass --trust-writer @login=FINGERPRINT)`,
    });
  }
  for (const who of unknown) approveWriter(identity, projectId, who);
};

// The options every read path passes to verifyVersion.
export const readPolicy = (argv, context, policy) => ({
  identity: context.identity,
  user: context.user,
  settings: context.settings || {},
  policy,
  trustWriters: argv.trustWriter || [],
  allowUnsigned: Boolean(argv.allowUnsigned),
  confirmUnsigned: Boolean(argv.allowUnsigned),
});
