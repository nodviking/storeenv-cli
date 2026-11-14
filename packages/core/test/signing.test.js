// Stage 1 of S1: writer signature primitives and the device chain replay.

import assert from "node:assert/strict";
import { test } from "node:test";
import * as core from "../src/index.js";

const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
const OTHER_PHRASE = core.generatePhrase();
const KNOWN_ASK_PUBLIC_KEY = "ts2mC7y5a0Jo3hO/CSxg+MHOaWIo8wT1ADhQ+OSyeQw=";

test("the account signing key comes from the phrase, is stable and is separate from the encryption key", () => {
  const a = core.deriveAccountSigningKey(PHRASE);
  const b = core.deriveAccountSigningKey(` ${PHRASE.toUpperCase()} `);
  assert.equal(a.publicKeyBase64, b.publicKeyBase64);
  assert.notEqual(a.publicKeyBase64, core.deriveIdentity(PHRASE).publicKeyBase64);
  assert.notEqual(a.publicKeyBase64, core.deriveAccountSigningKey(OTHER_PHRASE).publicKeyBase64);
  assert.throws(() => core.deriveAccountSigningKey("not a phrase"), (error) => error.code === "SE_INVALID");
  // Known answer: pins the derivation so it can't drift between releases.
  assert.equal(a.publicKeyBase64, KNOWN_ASK_PUBLIC_KEY);
});

test("canonical encoding separates null, empty and field boundaries", () => {
  const hex = (bytes) => core.toHex(bytes);
  assert.notEqual(hex(core.canonical("d", [null])), hex(core.canonical("d", [""])));
  assert.notEqual(hex(core.canonical("d", ["ab", "c"])), hex(core.canonical("d", ["a", "bc"])));
  assert.notEqual(hex(core.canonical("d1", ["x"])), hex(core.canonical("d2", ["x"])));
  assert.equal(hex(core.canonical("d", ["a"])), "00000001640000000161");
});

const setup = (phrase = PHRASE) => {
  const identity = core.deriveIdentity(phrase);
  const ask = core.deriveAccountSigningKey(phrase);
  const userId = "usr_000000000000000000000001";
  let index = 0;
  const leaves = [];
  const leaf = (event, extra = {}) => {
    const item = { index: index++, userId, login: "ana", event, publicKey: extra.publicKey ?? identity.publicKeyBase64, fingerprint: identity.fingerprint, at: new Date().toISOString(), payload: extra.payload ? JSON.stringify(extra.payload) : null };
    leaves.push(item);
    return item;
  };
  return { identity, ask, userId, leaves, leaf };
};

const where = { projectId: "prj_1", environment: "production", service: "api" };

const sealedEntry = (name = "API_KEY", value = "v") => {
  const aad = core.buildAad({ ...where, name, rev: 1 });
  return { id: "ent_000000000000000000000001", name, rev: 1, ...core.encryptSecret({ esk: core.generateEsk(), value, aad }) };
};

test("entry signatures cover every field and the location", () => {
  const { userId } = setup();
  const device = core.generateDeviceSigningKey();
  const entry = core.signEntry(sealedEntry(), { ...where, userId }, device);
  assert.equal(core.verifyEntrySignature(entry, where), true);
  for (const field of ["id", "name", "rev", "aad", "iv", "ciphertext", "authTag", "alg", "signerUserId"]) {
    const changed = { ...entry, [field]: field === "rev" ? 2 : `${entry[field]}x` };
    assert.equal(core.verifyEntrySignature(changed, where), false, `changing ${field} must break the signature`);
  }
  for (const moved of [{ ...where, projectId: "prj_2" }, { ...where, environment: "staging" }, { ...where, service: "web" }]) {
    assert.equal(core.verifyEntrySignature(entry, moved), false);
  }
  const other = core.generateDeviceSigningKey();
  assert.equal(core.verifyEntrySignature({ ...entry, signerKey: other.publicKeyBase64 }, where), false, "a different signer key fails");
  assert.equal(core.verifyEntrySignature({ ...entry, signature: undefined }, where), false, "missing signature fails");
  assert.equal(core.verifyEntrySignature({ ...entry, signature: entry.signature.slice(0, 40) }, where), false, "truncated signature fails");
  assert.equal(core.verifyEntrySignature({ ...entry, signature: "%%%" }, where), false, "malformed signature fails");
});

test("version signatures bind the parent, kind, place and every file digest", () => {
  const { userId } = setup();
  const device = core.generateDeviceSigningKey();
  const api = { service: "api", path: "api/.env", entries: [{ id: "ent_a", signature: "sigA" }, { id: "ent_b", signature: "sigB" }] };
  const hiddenDigest = core.fileDigest({ service: "billing", path: "billing/.env", entries: [{ id: "ent_h", signature: "sigH" }] });
  const version = { id: "ver_1", parent: "ver_0", projectId: "prj_1", environment: "production", kind: "push", manifest: [core.fileDigest(api), hiddenDigest] };
  const signed = { ...version, ...core.signVersion(version, { userId }, device) };
  assert.equal(core.verifyVersionSignature(signed), true);
  assert.equal(core.verifyVersionSignature({ ...signed, manifest: [...signed.manifest].reverse() }), true, "order of the list doesn't matter");
  assert.equal(core.checkVersionManifest(signed, [api], 1), true);
  assert.equal(core.checkVersionManifest(signed, [{ ...api, entries: [...api.entries].reverse() }], 1), true, "order of entries doesn't matter");

  // What a server could try on a visible file.
  for (const file of [
    { ...api, path: ".git/hooks/pre-commit" },
    { ...api, service: "web" },
    { ...api, entries: api.entries.slice(1) },
    { ...api, entries: [...api.entries, { id: "ent_c", signature: "sigC" }] },
    { ...api, entries: [{ id: "ent_a", signature: "other" }, api.entries[1]] },
    { ...api, entries: [{ id: "ent_a", signature: null }, api.entries[1]] },
  ]) assert.equal(core.checkVersionManifest(signed, [file], 1), false, JSON.stringify(file));
  assert.equal(core.checkVersionManifest(signed, [api], 0), false, "a hidden file can't be dropped");
  assert.equal(core.checkVersionManifest(signed, [api], 2), false, "or added");
  assert.equal(core.checkVersionManifest({ ...signed, manifest: [signed.manifest[0], signed.manifest[0]] }, [api], 1), false, "or duplicated");

  // What a server could try on the version itself.
  for (const item of [
    { ...signed, parent: "ver_x" },
    { ...signed, parent: null },
    { ...signed, kind: "rollback" },
    { ...signed, environment: "staging" },
    { ...signed, projectId: "prj_2" },
    { ...signed, id: "ver_2" },
    { ...signed, manifest: [core.fileDigest(api)] },
    { ...signed, manifest: [core.fileDigest(api), core.fileDigest({ service: "billing", path: "billing/.env", entries: [] })] },
    { ...signed, signerUserId: "usr_other" },
    { ...signed, signerKey: core.generateDeviceSigningKey().publicKeyBase64 },
    { ...signed, signature: undefined },
  ]) assert.equal(core.verifyVersionSignature(item), false, JSON.stringify(item).slice(0, 120));
});

test("device chain: the account key certifies, devices certify, revocation cascades", () => {
  const { identity, ask, userId, leaves, leaf } = setup();
  leaf("key.registered");
  leaf("signing.registered", { payload: core.signAccountBinding({ userId, publicKey: identity.publicKeyBase64 }, ask, identity.privateKey) });
  const laptop = core.generateDeviceSigningKey();
  const phone = core.generateDeviceSigningKey();
  const attacker = core.generateDeviceSigningKey();
  const base = { userId, accountKey: ask.publicKeyBase64 };
  leaf("device.added", { payload: core.certifyDevice({ ...base, deviceKey: laptop.publicKeyBase64, deviceName: "laptop" }, ask) });
  leaf("device.added", { payload: core.certifyDevice({ ...base, deviceKey: phone.publicKeyBase64, deviceName: "phone" }, laptop) });
  // A stolen phone certifies an attacker device.
  leaf("device.added", { payload: core.certifyDevice({ ...base, deviceKey: attacker.publicKeyBase64 }, phone) });
  let state = core.deviceStateFromLog(leaves, userId);
  assert.deepEqual([...state.devices.keys()].sort(), [laptop, phone, attacker].map((k) => k.publicKeyBase64).sort());

  // Revoking the phone also revokes what it certified.
  leaf("device.revoked", { payload: core.revokeDevice({ ...base, deviceKey: phone.publicKeyBase64 }, laptop) });
  state = core.deviceStateFromLog(leaves, userId);
  assert.deepEqual([...state.devices.keys()], [laptop.publicKeyBase64]);
  assert.ok(state.revoked.has(attacker.publicKeyBase64));

  // After revocation neither the phone nor its child can certify or revoke.
  const later = core.generateDeviceSigningKey();
  leaf("device.added", { payload: core.certifyDevice({ ...base, deviceKey: later.publicKeyBase64 }, phone) });
  leaf("device.added", { payload: core.certifyDevice({ ...base, deviceKey: later.publicKeyBase64 }, attacker) });
  leaf("device.revoked", { payload: core.revokeDevice({ ...base, deviceKey: laptop.publicKeyBase64 }, phone) });
  state = core.deviceStateFromLog(leaves, userId);
  assert.deepEqual([...state.devices.keys()], [laptop.publicKeyBase64]);
  assert.equal(state.rejected.length, 3);

  // A revoked key can't come back with a fresh certificate.
  leaf("device.added", { payload: core.certifyDevice({ ...base, deviceKey: phone.publicKeyBase64 }, ask) });
  assert.equal(core.deviceStateFromLog(leaves, userId).devices.has(phone.publicKeyBase64), false);
});

test("device chain: forged, foreign and out of order events change nothing", () => {
  const { identity, ask, userId, leaves, leaf } = setup();
  const stranger = core.deriveAccountSigningKey(OTHER_PHRASE);
  leaf("key.registered");
  // Certificate before any account key: ignored.
  const early = core.generateDeviceSigningKey();
  leaf("device.added", { payload: core.certifyDevice({ userId, accountKey: ask.publicKeyBase64, deviceKey: early.publicKeyBase64 }, ask) });
  // An account key binding signed by someone else.
  leaf("signing.registered", { payload: { ...core.signAccountBinding({ userId, publicKey: identity.publicKeyBase64 }, stranger, identity.privateKey), accountKey: ask.publicKeyBase64 } });
  leaf("signing.registered", { payload: core.signAccountBinding({ userId, publicKey: identity.publicKeyBase64 }, ask, identity.privateKey) });
  // A second account key for the same identity: ignored.
  leaf("signing.registered", { payload: core.signAccountBinding({ userId, publicKey: identity.publicKeyBase64 }, stranger, identity.privateKey) });
  const device = core.generateDeviceSigningKey();
  const forged = core.certifyDevice({ userId, accountKey: ask.publicKeyBase64, deviceKey: device.publicKeyBase64 }, stranger);
  leaf("device.added", { payload: { ...forged, issuer: ask.publicKeyBase64 } });
  leaf("device.added", { payload: core.certifyDevice({ userId: "usr_other", accountKey: ask.publicKeyBase64, deviceKey: device.publicKeyBase64 }, ask) });
  leaf("device.added", { payload: "not json" });
  const state = core.deviceStateFromLog(leaves, userId);
  assert.equal(state.accountKey, ask.publicKeyBase64);
  assert.equal(state.devices.size, 0);
  assert.equal(state.rejected.length, 6);
});

test("identity rotation voids every earlier certificate", () => {
  const { identity, ask, userId, leaves, leaf } = setup();
  leaf("key.registered");
  leaf("signing.registered", { payload: core.signAccountBinding({ userId, publicKey: identity.publicKeyBase64 }, ask, identity.privateKey) });
  const old = core.generateDeviceSigningKey();
  leaf("device.added", { payload: core.certifyDevice({ userId, accountKey: ask.publicKeyBase64, deviceKey: old.publicKeyBase64 }, ask) });
  const next = core.deriveIdentity(OTHER_PHRASE);
  const nextAsk = core.deriveAccountSigningKey(OTHER_PHRASE);
  leaf("key.replaced", { publicKey: next.publicKeyBase64 });
  let state = core.deviceStateFromLog(leaves, userId);
  assert.equal(state.devices.size, 0);
  assert.equal(state.accountKey, null);
  assert.ok(state.revoked.has(old.publicKeyBase64), "values the old device signed need a new signature");
  leaf("signing.registered", { payload: core.signAccountBinding({ userId, publicKey: next.publicKeyBase64 }, nextAsk, next.privateKey) });
  // The old certificate replayed under the new identity doesn't count.
  leaf("device.added", { payload: core.certifyDevice({ userId, accountKey: ask.publicKeyBase64, deviceKey: old.publicKeyBase64 }, ask) });
  const fresh = core.generateDeviceSigningKey();
  leaf("device.added", { payload: core.certifyDevice({ userId, accountKey: nextAsk.publicKeyBase64, deviceKey: fresh.publicKeyBase64 }, nextAsk) });
  state = core.deviceStateFromLog(leaves, userId);
  assert.deepEqual([...state.devices.keys()], [fresh.publicKeyBase64]);
});

test("log freshness: older than one hour or in the future fails closed", () => {
  const now = Date.parse("2026-11-13T12:00:00Z");
  assert.equal(core.checkLogFreshness({ at: "2026-11-13T11:30:00Z" }, now), true);
  for (const at of ["2026-11-13T10:59:00Z", "2026-11-13T12:06:00Z", "garbage", undefined]) {
    assert.throws(() => core.checkLogFreshness({ at }, now), (error) => error.code === "SE_LOG_STALE", String(at));
  }
});

test("v1 key leaves hash as before; v2 leaves commit to their payload", () => {
  const base = { index: 0, userId: "usr_1", login: "ana", publicKey: "pk", fingerprint: "SE:1", at: "2026-11-13T00:00:00.000Z" };
  assert.equal(core.toHex(core.leafHash(core.encodeKeyLeaf({ ...base, event: "key.registered", payload: "ignored" }))), core.toHex(core.leafHash(core.encodeKeyLeaf({ ...base, event: "key.registered" }))));
  const a = core.toHex(core.leafHash(core.encodeKeyLeaf({ ...base, event: "device.added", payload: "{\"a\":1}" })));
  const b = core.toHex(core.leafHash(core.encodeKeyLeaf({ ...base, event: "device.added", payload: "{\"a\":2}" })));
  assert.notEqual(a, b);
});

test("a complete log copy proves that no leaf was left out or changed", () => {
  const leaves = Array.from({ length: 7 }, (_, index) => ({ index, userId: `usr_${index % 2}`, login: "x", event: index % 3 ? "device.added" : "key.registered", publicKey: "pk", fingerprint: null, at: "2026-11-13T00:00:00.000Z", payload: `{"n":${index}}` }));
  const root = core.toBase64(core.merkleRoot(leaves.map((leaf) => core.leafHash(core.encodeKeyLeaf(leaf)))));
  const head = { size: 7, root };
  assert.equal(core.verifyCompleteLog(head, leaves), true);
  assert.equal(core.verifyCompleteLog(head, leaves.slice(0, 6)), false, "a withheld last leaf");
  assert.equal(core.verifyCompleteLog(head, [...leaves.slice(0, 3), ...leaves.slice(4)]), false, "a withheld middle leaf");
  assert.equal(core.verifyCompleteLog(head, leaves.map((leaf, i) => (i === 4 ? { ...leaf, payload: "{}" } : leaf))), false, "a changed payload");
  assert.equal(core.verifyCompleteLog(head, [leaves[1], leaves[0], ...leaves.slice(2)]), false, "reordered");
});

test("an account key can only be bound by the holder of the identity key", () => {
  const { identity, ask, userId, leaves, leaf } = setup();
  leaf("key.registered");
  // A server knows the public key but not the identity's private key: its
  // own account key, signed by itself, with a proof from another X25519 key.
  const serverAsk = core.generateDeviceSigningKey();
  const serverX = core.generateKeyPair();
  leaf("signing.registered", { payload: core.signAccountBinding({ userId, publicKey: identity.publicKeyBase64 }, serverAsk, serverX.privateKey) });
  const binding = core.signAccountBinding({ userId, publicKey: identity.publicKeyBase64 }, serverAsk, serverX.privateKey);
  leaf("signing.registered", { payload: { ...binding, identityProof: undefined } });
  assert.equal(core.deviceStateFromLog(leaves, userId).accountKey, null);
  leaf("signing.registered", { payload: core.signAccountBinding({ userId, publicKey: identity.publicKeyBase64 }, ask, identity.privateKey) });
  assert.equal(core.deviceStateFromLog(leaves, userId).accountKey, ask.publicKeyBase64);
});

test("XEdDSA: X25519 keys sign; the signature checks against the X25519 public key only", () => {
  for (let i = 0; i < 50; i++) {
    const pair = core.generateKeyPair();
    const message = core.utf8(`m${i}`);
    const signature = core.xeddsaSign(pair.privateKey, message);
    assert.equal(core.xeddsaVerify(pair.publicKey, message, signature), true);
    assert.equal(core.xeddsaVerify(pair.publicKey, core.utf8("other"), signature), false);
    assert.equal(core.xeddsaVerify(core.generateKeyPair().publicKey, message, signature), false);
    const flipped = Uint8Array.from(signature);
    flipped[i % 64] ^= 1;
    assert.equal(core.xeddsaVerify(pair.publicKey, message, flipped), false);
  }
});
