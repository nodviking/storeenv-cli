// The rules for deciding whose public keys a client may encrypt for. Shared
// by the CLI (keys pinned in ~/.storeenv/known_keys) and the web app (pinned
// in the browser), so both enforce exactly the same checks. Storage and how
// to ask the person stay with each client.
//
// 1. Key log: the signed head must verify with the pinned log key, must be
//    consistent with the last head this client saw, and every key a reader
//    is given must be that person's latest leaf in it.
// 2. Pins: a key that matches the pin is trusted; a logged key that differs
//    from the pin is a rotation that needs re-verification; a key never seen
//    is new and needs a decision.

import { StoreEnvError } from "./errors.js";
import { fingerprintOf } from "./identity.js";
import { concatBytes, fromBase64 } from "./bytes.js";
import { encodeKeyLeaf, leafHash, logKeyId, verifyConsistency, verifyHead, verifyInclusion } from "./transparency.js";

const b64 = (text) => fromBase64(text);
const broken = (message) => new StoreEnvError("SE_KEY_LOG_INCONSISTENT", message);

export const sameFingerprint = (a, b) => {
  const clean = (text) => String(text || "").toUpperCase().replace(/^SE:?/, "").replace(/[^0-9A-F]/g, "");
  return clean(a).length > 0 && clean(a) === clean(b);
};

// Checks a new signed head against what this client knew before.
// pinned: { publicKey, head?: { size, root } } or null on first use.
// fetchConsistency(from, to) -> { proof: [base64] }.
// Returns the log state to store next.
export const verifyLogUpdate = async ({ head, pinned, presetLogKey = null, fetchConsistency }) => {
  const logKey = pinned?.publicKey || presetLogKey || null;
  if (logKey && logKey !== head.logKey) throw broken(`The server's key log is signed by ${head.logKeyId}, not the pinned ${logKeyId(logKey)}.`);
  if (!verifyHead(head, logKey || head.logKey)) throw broken("The key log head has a bad signature.");
  const last = pinned?.head;
  if (last) {
    if (head.size < last.size) throw broken(`The key log shrank from ${last.size} to ${head.size} entries.`);
    const { proof } = await fetchConsistency(last.size, head.size);
    if (!verifyConsistency({ oldSize: last.size, newSize: head.size, oldRoot: b64(last.root), newRoot: b64(head.root), proof: proof.map(b64) })) {
      throw broken(`The key log at ${head.size} entries doesn't extend the one this device saw at ${last.size}. Past key events were changed.`);
    }
  }
  return {
    firstUse: !pinned,
    state: { publicKey: logKey || head.logKey, keyId: head.logKeyId, pinnedAt: pinned?.pinnedAt || new Date().toISOString(), head: { size: head.size, root: head.root, at: head.at } },
  };
};

// Verifies each leaf's inclusion proof against the head. Returns Map(userId -> leaf).
export const verifyLeaves = (head, leaves) => {
  const out = new Map();
  for (const leaf of leaves) {
    if (!verifyInclusion({ leafHash: leafHash(encodeKeyLeaf(leaf)), index: leaf.index, size: head.size, proof: leaf.proof.map(b64), root: b64(head.root) })) {
      throw broken(`The key log entry for @${leaf.login} doesn't belong to the signed log.`);
    }
    out.set(leaf.userId, leaf);
  }
  return out;
};

// "@ana=SE:...,@bo=SE:..." -> Map(login -> fingerprint)
export const parseTrustedKeys = (text) => {
  const out = new Map();
  for (const item of String(text || "").split(",")) {
    const [login, fingerprint] = item.split("=").map((part) => part?.trim());
    if (login && fingerprint) out.set(login.replace(/^@/, "").toLowerCase(), fingerprint.toUpperCase());
  }
  return out;
};

// Checks the server's reader list before anything is encrypted.
// people: [{ userId, login, publicKey, fingerprint? }] (only those with keys)
// leaves: Map(userId -> verified leaf); pins: { [userId]: { publicKey, fingerprint } }
// self: { publicKey, login }; provisioned: Map(login -> fingerprint)
// Returns { trusted, fresh, provisionedPins }. Throws SE_KEY_MISMATCH or
// SE_KEY_ROTATION_REQUIRED.
export const classifyReaders = ({ people, leaves, pins = {}, self, provisioned = new Map() }) => {
  const trusted = [];
  const fresh = [];
  const provisionedPins = [];
  for (const person of people) {
    const fingerprint = fingerprintOf(person.publicKey);
    if (person.fingerprint && person.fingerprint !== fingerprint) {
      throw new StoreEnvError("SE_KEY_MISMATCH", `The server sent a key for @${person.login} that doesn't match its own fingerprint.`);
    }
    if (self.login && person.login === self.login && person.publicKey !== self.publicKey) {
      throw new StoreEnvError("SE_KEY_MISMATCH", `The server lists a key for you (@${self.login}) that this device doesn't hold.`, { hint: "Nothing was encrypted. Check your identity, and recover with your phrase if you replaced it" });
    }
    const leaf = leaves.get(person.userId);
    if (!leaf || leaf.event === "key.removed" || leaf.publicKey !== person.publicKey) {
      throw new StoreEnvError("SE_KEY_MISMATCH", `The server gave a key for @${person.login} (${fingerprint}) that isn't their key in the signed log${leaf?.fingerprint ? ` (${leaf.fingerprint})` : ""}.`);
    }
    const vetted = { ...person, fingerprint, keyVersion: leaf.index };
    if (person.publicKey === self.publicKey) {
      trusted.push(vetted);
      continue;
    }
    const pin = pins[person.userId];
    if (pin?.publicKey === person.publicKey) {
      trusted.push(vetted);
      continue;
    }
    if (pin) {
      throw new StoreEnvError("SE_KEY_ROTATION_REQUIRED", `@${person.login} replaced their key: ${pin.fingerprint} is now ${fingerprint} (logged as entry ${leaf.index}).`, {
        hint: `Nothing was encrypted. Anyone who got @${person.login}'s account could do this, so confirm the new fingerprint with them in person or on a call, then verify @${person.login} again with ${fingerprint}`,
      });
    }
    const given = provisioned.get(person.login);
    if (given) {
      if (!sameFingerprint(given, fingerprint)) throw new StoreEnvError("SE_KEY_MISMATCH", `STOREENV_TRUSTED_KEYS says @${person.login} is ${given}, but their key is ${fingerprint}.`);
      provisionedPins.push(vetted);
      trusted.push(vetted);
      continue;
    }
    fresh.push(vetted);
  }
  return { trusted, fresh, provisionedPins };
};

// ---- Device approval ----------------------------------------------------------
// A new device shows the fingerprint of its own one-time device key, worked
// out on that device. The approving device seals the private key only if the
// key the server reports for the request has that same fingerprint, so a
// server that swaps in its own key gets nothing. The approval code alone
// can't do this: the server makes and stores it.

// With a device signing key (S1) the fingerprint covers both keys, so the
// approver certifies the signing key the new device really holds.
export const deviceKeyFingerprint = (ephemeralPublicKey, signingKey = null) => {
  if (!signingKey) return fingerprintOf(ephemeralPublicKey);
  const bytes = (key) => (typeof key === "string" ? fromBase64(key) : key);
  return fingerprintOf(concatBytes(bytes(ephemeralPublicKey), bytes(signingKey)));
};

// typed: the device key the person read off the new device.
export const checkDeviceKey = (request, typed) => {
  if (!typed) {
    throw new StoreEnvError("SE_KEY_NOT_VERIFIED", "Type the device key shown on the new device to approve it.", { hint: "The new device shows \"Device key SE:XXXX-XXXX-XXXX\" next to its approval code" });
  }
  const actual = deviceKeyFingerprint(request.ephemeralPublicKey, request.signingKey || null);
  if (!sameFingerprint(typed, actual)) {
    throw new StoreEnvError("SE_KEY_MISMATCH", `The server's key for this request is ${actual}, not the device key ${typed} you typed. Nothing was sent.`, {
      hint: "Check the device key on the new device again. If it really differs, someone may be trying to receive your private key: deny the request",
    });
  }
  return actual;
};

// The account's own key must be its latest entry in the signed log, on both
// sides of an approval: the approver doesn't hand out a key the log no
// longer vouches for, and a new device doesn't accept one it never did.
export const checkOwnKey = ({ leaves, userId, publicKey }) => {
  const leaf = leaves.get(userId);
  if (!leaf || leaf.event === "key.removed" || leaf.publicKey !== publicKey) {
    throw new StoreEnvError("SE_KEY_MISMATCH", `This identity (${fingerprintOf(publicKey)}) isn't your latest key in the signed key log${leaf?.fingerprint ? ` (${leaf.fingerprint})` : ""}.`, {
      hint: "Nothing was accepted or sent. If you didn't replace your identity, report this to whoever runs your StoreEnv server",
    });
  }
  return leaf;
};
