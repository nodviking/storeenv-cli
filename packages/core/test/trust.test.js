import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  classifyReaders, consistencyProof, encodeKeyLeaf, fingerprintOf, generateKeyPair, inclusionProof, leafHash, logKeyPair, merkleRoot,
  parseTrustedKeys, signHead, toBase64, verifyLeaves, verifyLogUpdate,
} from "../src/index.js";

// The shared trust rules the CLI and the web app both run, against a real
// signed log built here (what an honest server would serve).

const log = logKeyPair(new Uint8Array(32).fill(3));
const otherLog = logKeyPair(new Uint8Array(32).fill(4));
const person = (login, i) => {
  const pair = generateKeyPair();
  return { userId: `usr_${login}`, login, publicKey: toBase64(pair.publicKey), fingerprint: fingerprintOf(pair.publicKey), index: i };
};
const me = person("me", 0);
const ana = person("ana", 1);
const bo = person("bo", 2);
const people = [me, ana, bo];

const leafOf = (p, extra = {}) => ({ index: p.index, userId: p.userId, login: p.login, event: "key.registered", publicKey: p.publicKey, fingerprint: p.fingerprint, at: "2026-11-12T00:00:00.000Z", ...extra });
const build = (leaves, key = log) => {
  const hashes = leaves.map((leaf) => leafHash(encodeKeyLeaf(leaf)));
  const head = { size: hashes.length, root: toBase64(merkleRoot(hashes)), at: "2026-11-12T00:00:00.000Z" };
  return {
    hashes,
    head: { ...head, signature: signHead(head, key.privateKey), logKey: toBase64(key.publicKey), logKeyId: "LOG:TEST" },
    proofs: leaves.map((leaf) => ({ ...leaf, proof: inclusionProof(leaf.index, hashes).map(toBase64) })),
  };
};
const honest = build(people.map((p) => leafOf(p)));
const fetchFrom = (hashes) => async (from, to) => ({ proof: consistencyProof(from, hashes.slice(0, to)).map(toBase64) });
const self = { publicKey: me.publicKey, login: "me" };
const reader = (p, extra = {}) => ({ userId: p.userId, login: p.login, publicKey: p.publicKey, fingerprint: p.fingerprint, ...extra });

describe("key log checks", () => {
  test("first use pins the log key; an honest extension verifies", async () => {
    const first = await verifyLogUpdate({ head: honest.head, pinned: null, fetchConsistency: fetchFrom(honest.hashes) });
    assert.equal(first.firstUse, true);
    const carol = person("carol", 3);
    const grown = build([...people.map((p) => leafOf(p)), leafOf(carol)]);
    const next = await verifyLogUpdate({ head: grown.head, pinned: first.state, fetchConsistency: fetchFrom(grown.hashes) });
    assert.equal(next.state.head.size, 4);
  });

  test("a head signed by another log key is refused", async () => {
    const first = await verifyLogUpdate({ head: honest.head, pinned: null, fetchConsistency: fetchFrom(honest.hashes) });
    const forged = build(people.map((p) => leafOf(p)), otherLog);
    await assert.rejects(verifyLogUpdate({ head: forged.head, pinned: first.state, fetchConsistency: fetchFrom(forged.hashes) }), { code: "SE_KEY_LOG_INCONSISTENT" });
  });

  test("a bad signature is refused, even on first use", async () => {
    await assert.rejects(verifyLogUpdate({ head: { ...honest.head, size: 99 }, pinned: null, fetchConsistency: fetchFrom(honest.hashes) }), { code: "SE_KEY_LOG_INCONSISTENT" });
  });

  test("a rewritten or shrunken log is refused", async () => {
    const first = await verifyLogUpdate({ head: honest.head, pinned: null, fetchConsistency: fetchFrom(honest.hashes) });
    const attacker = person("ana", 1);
    const rewritten = build([leafOf(me), leafOf(attacker), leafOf(bo), leafOf(person("x", 3))]);
    await assert.rejects(verifyLogUpdate({ head: rewritten.head, pinned: first.state, fetchConsistency: fetchFrom(rewritten.hashes) }), { code: "SE_KEY_LOG_INCONSISTENT" });
    const shrunk = build([leafOf(me), leafOf(ana)]);
    await assert.rejects(verifyLogUpdate({ head: shrunk.head, pinned: first.state, fetchConsistency: fetchFrom(shrunk.hashes) }), /shrank/);
  });

  test("a leaf whose proof doesn't match the head is refused", () => {
    const tampered = honest.proofs.map((leaf) => (leaf.login === "ana" ? { ...leaf, publicKey: bo.publicKey } : leaf));
    assert.throws(() => verifyLeaves(honest.head, tampered), { code: "SE_KEY_LOG_INCONSISTENT" });
    assert.equal(verifyLeaves(honest.head, honest.proofs).size, 3);
  });
});

describe("reader classification", () => {
  const leaves = verifyLeaves(honest.head, honest.proofs);

  test("pinned readers are trusted, unknown ones are new, nothing is trusted by default", () => {
    const { trusted, fresh } = classifyReaders({ people: [reader(me), reader(ana), reader(bo)], leaves, pins: { [ana.userId]: { publicKey: ana.publicKey, fingerprint: ana.fingerprint } }, self });
    assert.deepEqual(trusted.map((p) => p.login).sort(), ["ana", "me"]);
    assert.deepEqual(fresh.map((p) => p.login), ["bo"]);
    assert.equal(fresh[0].keyVersion, 2);
  });

  test("a key the server hands out that isn't in the log is refused", () => {
    const attacker = generateKeyPair();
    const injected = { userId: bo.userId, login: "bo", publicKey: toBase64(attacker.publicKey), fingerprint: fingerprintOf(attacker.publicKey) };
    assert.throws(() => classifyReaders({ people: [injected], leaves, self }), { code: "SE_KEY_MISMATCH" });
    // A reader the log has never heard of, too.
    const stranger = person("stranger", 9);
    assert.throws(() => classifyReaders({ people: [reader(stranger)], leaves, self }), { code: "SE_KEY_MISMATCH" });
  });

  test("a fingerprint that doesn't match the key the server sent is refused", () => {
    assert.throws(() => classifyReaders({ people: [reader(ana, { fingerprint: bo.fingerprint })], leaves, self }), { code: "SE_KEY_MISMATCH" });
  });

  test("a server key for me that I don't hold is refused", () => {
    assert.throws(() => classifyReaders({ people: [reader(ana, { login: "me" })], leaves, self }), { code: "SE_KEY_MISMATCH" });
  });

  test("a logged key change against a pin needs re-verification", () => {
    const rotated = person("ana", 3);
    const grown = build([...people.map((p) => leafOf(p)), leafOf({ ...rotated, userId: ana.userId }, { event: "key.replaced" })]);
    const newLeaves = verifyLeaves(grown.head, grown.proofs.filter((leaf) => leaf.index !== 1));
    const pins = { [ana.userId]: { publicKey: ana.publicKey, fingerprint: ana.fingerprint } };
    assert.throws(
      () => classifyReaders({ people: [{ userId: ana.userId, login: "ana", publicKey: rotated.publicKey, fingerprint: rotated.fingerprint }], leaves: newLeaves, pins, self }),
      (error) => error.code === "SE_KEY_ROTATION_REQUIRED" && error.message.includes(ana.fingerprint) && error.message.includes(rotated.fingerprint),
    );
  });

  test("a removed key is never encrypted for", () => {
    const gone = build([...people.map((p) => leafOf(p)), leafOf({ ...bo, index: 3 }, { event: "key.removed" })]);
    const newLeaves = verifyLeaves(gone.head, gone.proofs.filter((leaf) => leaf.index !== 2));
    assert.throws(() => classifyReaders({ people: [reader(bo)], leaves: newLeaves, self }), { code: "SE_KEY_MISMATCH" });
  });

  test("pre-provided fingerprints count only when they match", () => {
    const ok = classifyReaders({ people: [reader(bo)], leaves, self, provisioned: parseTrustedKeys(`@bo=${bo.fingerprint}`) });
    assert.deepEqual(ok.provisionedPins.map((p) => p.login), ["bo"]);
    assert.throws(() => classifyReaders({ people: [reader(bo)], leaves, self, provisioned: parseTrustedKeys("@bo=SE:0000-0000-0000") }), { code: "SE_KEY_MISMATCH" });
  });
});

describe("device approval", () => {
  const leaves = verifyLeaves(honest.head, honest.proofs);

  test("the device key must be typed and must match the server's request key", async () => {
    const { checkDeviceKey, deviceKeyFingerprint } = await import("../src/index.js");
    const device = generateKeyPair();
    const request = { ephemeralPublicKey: toBase64(device.publicKey) };
    assert.equal(checkDeviceKey(request, deviceKeyFingerprint(request.ephemeralPublicKey)), fingerprintOf(device.publicKey));
    assert.throws(() => checkDeviceKey(request, ""), { code: "SE_KEY_NOT_VERIFIED" });
    // The server swapped in its own key: the fingerprint the person read off
    // the real device no longer matches.
    const swapped = { ephemeralPublicKey: toBase64(generateKeyPair().publicKey) };
    assert.throws(() => checkDeviceKey(swapped, fingerprintOf(device.publicKey)), { code: "SE_KEY_MISMATCH" });
  });

  test("an identity is accepted or handed out only if it is the account's logged key", async () => {
    const { checkOwnKey } = await import("../src/index.js");
    assert.equal(checkOwnKey({ leaves, userId: me.userId, publicKey: me.publicKey }).index, 0);
    const attacker = toBase64(generateKeyPair().publicKey);
    assert.throws(() => checkOwnKey({ leaves, userId: me.userId, publicKey: attacker }), { code: "SE_KEY_MISMATCH" });
    assert.throws(() => checkOwnKey({ leaves: new Map(), userId: me.userId, publicKey: me.publicKey }), { code: "SE_KEY_MISMATCH" });
  });
});
