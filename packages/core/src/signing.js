// Writer signatures (S1). Who wrote a value, checked on every client before
// the value is used, so a server or database that forges, moves, replays or
// drops entries is caught.
//
// Keys
//   Account signing key (ASK): Ed25519, derived from the 24 word recovery
//     phrase only. Devices never keep it. It certifies devices and revokes
//     them, and is bound to the account's X25519 key in the key log.
//   Device signing key (DSK): Ed25519, generated on each device, never
//     leaves it. Signs entries and versions.
//
// Every certificate and revocation is a leaf in the key transparency log.
// deviceStateFromLog replays one account's leaves in log order, so a device
// only counts while every device above it in the chain is unrevoked, and a
// device's signature stops counting once its revocation is in the log.
// Identity rotation (key.replaced) voids every earlier certificate.

import { ed25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { mnemonicToEntropy } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { concatBytes, fromBase64, toBase64, toHex, utf8 } from "./bytes.js";
import { StoreEnvError } from "./errors.js";
import { isValidPhrase, normalizePhrase } from "./identity.js";
import { xeddsaSign, xeddsaVerify } from "./xeddsa.js";

export const ACCOUNT_SIGN_INFO = "storeenv/sign/account/v1";
export const DOMAINS = Object.freeze({
  account: "storeenv/account-key/v1",
  cert: "storeenv/device-cert/v1",
  revoke: "storeenv/device-revoke/v1",
  entry: "storeenv/entry/v1",
  file: "storeenv/file/v1",
  version: "storeenv/version/v1",
});
// Log heads older than this are refused for sensitive operations.
export const LOG_FRESHNESS_MS = 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

const bytesOf = (key) => (typeof key === "string" ? fromBase64(key) : key);

// ---- Keys --------------------------------------------------------------------

const signingPair = (privateKey) => {
  const publicKey = ed25519.getPublicKey(privateKey);
  return { privateKey, publicKey, publicKeyBase64: toBase64(publicKey), keyId: signingKeyId(publicKey) };
};

export const signingKeyId = (publicKey) => `SIG:${toHex(sha256(bytesOf(publicKey)).subarray(0, 6)).toUpperCase().replace(/(.{4})(?=.)/g, "$1-")}`;

// The phrase is used here and dropped; only the derived key leaves.
export const deriveAccountSigningKey = (phrase) => {
  const normal = normalizePhrase(phrase);
  if (!isValidPhrase(normal)) throw new StoreEnvError("SE_INVALID", "That recovery phrase isn't valid. Check each word and the order.");
  const seed = mnemonicToEntropy(normal, wordlist);
  const privateKey = hkdf(sha256, seed, undefined, utf8(ACCOUNT_SIGN_INFO), 32);
  seed.fill(0);
  return signingPair(privateKey);
};

export const generateDeviceSigningKey = () => signingPair(ed25519.utils.randomSecretKey());
export const deviceSigningKeyFrom = (privateKey) => signingPair(bytesOf(privateKey));

// ---- Canonical encoding ----------------------------------------------------------
// Domain, then each field as a 4 byte big endian length and its UTF-8 bytes.
// null is a length of 0xFFFFFFFF, so null and "" differ.

export const canonical = (domain, fields) => {
  const parts = [];
  for (const field of [domain, ...fields]) {
    const length = new Uint8Array(4);
    if (field === null || field === undefined) {
      new DataView(length.buffer).setUint32(0, 0xffffffff);
      parts.push(length);
      continue;
    }
    const bytes = utf8(String(field));
    new DataView(length.buffer).setUint32(0, bytes.length);
    parts.push(length, bytes);
  }
  return concatBytes(...parts);
};

const sign = (bytes, privateKey) => toBase64(ed25519.sign(bytes, bytesOf(privateKey)));
const verify = (signature, bytes, publicKey) => {
  try {
    return typeof signature === "string" && ed25519.verify(fromBase64(signature), bytes, bytesOf(publicKey));
  } catch {
    return false;
  }
};

// ---- Account key binding -------------------------------------------------------------
// Signed twice: by the account key (it holds the key) and, with XEdDSA, by
// the account's X25519 identity key (the identity vouches for it). The
// server never has the identity key, so it can't bind an account key of its
// own to anyone, even an account that hasn't set up signing yet.

const accountFields = ({ userId, publicKey, accountKey }) => [userId, publicKey, accountKey];
export const signAccountBinding = ({ userId, publicKey }, ask, identityPrivateKey) => {
  const binding = { userId, publicKey, accountKey: ask.publicKeyBase64 };
  const bytes = canonical(DOMAINS.account, accountFields(binding));
  return { ...binding, signature: sign(bytes, ask.privateKey), identityProof: toBase64(xeddsaSign(bytesOf(identityPrivateKey), bytes)) };
};
export const verifyAccountBinding = (binding) => {
  const bytes = canonical(DOMAINS.account, accountFields(binding || {}));
  if (!verify(binding?.signature, bytes, binding?.accountKey)) return false;
  try {
    return typeof binding.identityProof === "string" && xeddsaVerify(fromBase64(binding.publicKey), bytes, fromBase64(binding.identityProof));
  } catch {
    return false;
  }
};

// ---- Device certificates and revocations ---------------------------------------------
// issuer: the base64 public key that signed (the ASK or a device key).

const certFields = (c) => [c.userId, c.accountKey, c.deviceKey, c.deviceName ?? null, c.issuer, c.issuedAt];
export const certifyDevice = ({ userId, accountKey, deviceKey, deviceName = null, issuedAt = new Date().toISOString() }, issuerKey) => {
  const cert = { userId, accountKey, deviceKey, deviceName, issuer: issuerKey.publicKeyBase64, issuedAt };
  return { ...cert, signature: sign(canonical(DOMAINS.cert, certFields(cert)), issuerKey.privateKey) };
};
export const verifyCertSignature = (cert) => verify(cert?.signature, canonical(DOMAINS.cert, certFields(cert)), cert?.issuer);

const revokeFields = (r) => [r.userId, r.accountKey, r.deviceKey, r.issuer, r.revokedAt];
export const revokeDevice = ({ userId, accountKey, deviceKey, revokedAt = new Date().toISOString() }, issuerKey) => {
  const revocation = { userId, accountKey, deviceKey, issuer: issuerKey.publicKeyBase64, revokedAt };
  return { ...revocation, signature: sign(canonical(DOMAINS.revoke, revokeFields(revocation)), issuerKey.privateKey) };
};
export const verifyRevocationSignature = (r) => verify(r?.signature, canonical(DOMAINS.revoke, revokeFields(r)), r?.issuer);

// ---- Replaying an account's log ---------------------------------------------------
// leaves: that account's verified leaves in log order. Leaves that don't
// verify, or that the account's state at that point doesn't allow, are
// listed in `rejected` and change nothing: the server can append them but
// can't make them count.

export const deviceStateFromLog = (leaves, userId) => {
  const state = { userId, publicKey: null, accountKey: null, devices: new Map(), revoked: new Set(), rejected: [], lastIndex: -1 };
  const reject = (leaf, reason) => state.rejected.push({ index: leaf.index, event: leaf.event, reason });
  const removeWithDescendants = (key) => {
    const queue = [key];
    while (queue.length) {
      const current = queue.shift();
      if (state.devices.delete(current) || current === key) state.revoked.add(current);
      for (const [other, info] of state.devices) if (info.issuer === current) queue.push(other);
    }
  };

  for (const leaf of [...leaves].sort((a, b) => a.index - b.index)) {
    if (leaf.userId !== userId) continue;
    state.lastIndex = leaf.index;
    const payload = typeof leaf.payload === "string" ? safeJson(leaf.payload) : leaf.payload || null;
    switch (leaf.event) {
      case "key.registered":
      case "key.replaced":
      case "key.removed":
        // A new (or no) X25519 identity: every earlier signing authority is
        // void. Its device keys count as revoked, so what they signed reads
        // as needing a new signature, and they can never be certified again.
        state.publicKey = leaf.event === "key.removed" ? null : leaf.publicKey;
        state.accountKey = null;
        for (const key of state.devices.keys()) state.revoked.add(key);
        state.devices.clear();
        break;
      case "signing.registered":
        if (!state.publicKey) reject(leaf, "no identity");
        else if (state.accountKey) reject(leaf, "account key already set for this identity");
        else if (!payload || payload.userId !== userId || payload.publicKey !== state.publicKey || !verifyAccountBinding(payload)) reject(leaf, "bad account binding");
        else state.accountKey = payload.accountKey;
        break;
      case "device.added": {
        const cert = payload;
        const issuerOk = cert && (cert.issuer === state.accountKey || state.devices.has(cert.issuer));
        if (!state.accountKey) reject(leaf, "no account key");
        else if (!cert || cert.userId !== userId || cert.accountKey !== state.accountKey) reject(leaf, "certificate for another account key");
        else if (!issuerOk) reject(leaf, "issuer isn't the account key or a current device");
        else if (state.revoked.has(cert.deviceKey) || state.devices.has(cert.deviceKey)) reject(leaf, "device key already used");
        else if (!verifyCertSignature(cert)) reject(leaf, "bad certificate signature");
        else state.devices.set(cert.deviceKey, { issuer: cert.issuer, index: leaf.index, deviceName: cert.deviceName, issuedAt: cert.issuedAt });
        break;
      }
      case "device.revoked": {
        const revocation = payload;
        const issuerOk = revocation && (revocation.issuer === state.accountKey || state.devices.has(revocation.issuer));
        if (!state.accountKey) reject(leaf, "no account key");
        else if (!revocation || revocation.userId !== userId || revocation.accountKey !== state.accountKey) reject(leaf, "revocation for another account key");
        else if (!issuerOk) reject(leaf, "issuer isn't the account key or a current device");
        else if (!verifyRevocationSignature(revocation)) reject(leaf, "bad revocation signature");
        else removeWithDescendants(revocation.deviceKey);
        break;
      }
      default:
        break;
    }
  }
  return state;
};

const safeJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// ---- Entry and version signatures ----------------------------------------------------

const entryFields = (e) => [e.id, e.projectId, e.environment, e.service, e.name, e.rev, e.alg, e.aad, e.iv, e.ciphertext, e.authTag, e.signerUserId, e.signerKey];

export const signEntry = (entry, { projectId, environment, service, userId }, deviceKey) => {
  const signed = { ...entry, signerUserId: userId, signerKey: deviceKey.publicKeyBase64 };
  return { ...signed, signature: sign(canonical(DOMAINS.entry, entryFields({ ...signed, projectId, environment, service })), deviceKey.privateKey) };
};

export const verifyEntrySignature = (entry, { projectId, environment, service }) =>
  verify(entry?.signature, canonical(DOMAINS.entry, entryFields({ ...entry, projectId, environment, service })), entry?.signerKey);

// A file of a version: its service, path and every entry's id and
// signature (sorted by id). Names, values and revisions are bound by each
// entry's own signature, so a writer can sign entries it can't read.
export const fileDigest = (file) => {
  const entries = [...(file.entries || [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const fields = [file.service, file.path, entries.length];
  for (const entry of entries) fields.push(entry.id, entry.signature ?? null);
  return toHex(sha256(canonical(DOMAINS.file, fields)));
};

// A version signs the digests of all its files, sorted. Files hidden from a
// reader by scoping arrive only as digests; the reader checks the files it
// can see against the list and the list against the signature.
const versionFields = (v) => {
  const manifest = [...(v.manifest || [])].sort();
  return [v.id, v.parent ?? null, v.projectId, v.environment, v.kind, v.signerUserId, v.signerKey, manifest.length, ...manifest];
};

export const signVersion = (version, { userId }, deviceKey) => {
  const signed = { ...version, signerUserId: userId, signerKey: deviceKey.publicKeyBase64 };
  return { signerUserId: userId, signerKey: signed.signerKey, signature: sign(canonical(DOMAINS.version, versionFields(signed)), deviceKey.privateKey) };
};

export const verifyVersionSignature = (version) => verify(version?.signature, canonical(DOMAINS.version, versionFields(version)), version?.signerKey);

// Visible files must each be in the signed manifest, and the manifest must
// hold exactly the visible files plus the ones hidden from this reader.
export const checkVersionManifest = (version, visibleFiles, hiddenCount = 0) => {
  const manifest = version?.manifest || [];
  if (new Set(manifest).size !== manifest.length) return false;
  if (manifest.length !== visibleFiles.length + Number(hiddenCount || 0)) return false;
  const listed = new Set(manifest);
  return visibleFiles.every((file) => listed.has(fileDigest(file)));
};

// The manifest a push will produce, worked out the way the API composes the
// version: the head's files, with each pushed file replacing the head file
// of its service, removed services dropped and empty files left out.
// head: the head as served (visible files with entry signatures, manifest of
// all digests), already verified by the caller. files: the pushed files,
// entries either { ref } (a head entry) or a new signed entry.
export const composeManifest = ({ head, files = [], removeFiles = [] }) => {
  const digests = new Set(head?.manifest || []);
  const headFiles = new Map((head?.files || []).map((file) => [file.service, file]));
  const known = new Map();
  for (const file of head?.files || []) for (const entry of file.entries) known.set(entry.id, entry.signature ?? null);
  for (const service of [...files.map((file) => file.service), ...removeFiles]) {
    const before = headFiles.get(service);
    if (before) digests.delete(fileDigest(before));
  }
  for (const file of files) {
    const entries = (file.entries || []).map((entry) => (entry.ref ? { id: entry.ref, signature: known.has(entry.ref) ? known.get(entry.ref) : entry.signature ?? null } : { id: entry.id, signature: entry.signature ?? null }));
    if (entries.length) digests.add(fileDigest({ service: file.service, path: file.path, entries }));
  }
  return [...digests].sort();
};

// ---- Freshness -------------------------------------------------------------------

export const checkLogFreshness = (head, now = Date.now()) => {
  const at = new Date(head?.at).getTime();
  if (!Number.isFinite(at)) throw new StoreEnvError("SE_LOG_STALE", "The key log head has no valid time.");
  if (at > now + CLOCK_SKEW_MS) throw new StoreEnvError("SE_LOG_STALE", `The key log head is dated in the future (${head.at}). Check this computer's clock.`);
  if (now - at > LOG_FRESHNESS_MS) throw new StoreEnvError("SE_LOG_STALE", `The key log head is from ${head.at}, older than one hour. A revocation may be missing.`);
  return true;
};
