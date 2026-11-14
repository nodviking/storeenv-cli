import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  consistencyProof, encodeKeyLeaf, inclusionProof, leafHash, logKeyPair, merkleRoot, signHead, verifyConsistency, verifyHead, verifyInclusion,
} from "../src/index.js";

const leaves = (n) => Array.from({ length: n }, (_, i) => leafHash(encodeKeyLeaf({ index: i, userId: `usr_${i}`, login: `u${i}`, event: "key.registered", publicKey: `pk${i}`, fingerprint: `SE:${i}`, at: 0 })));

describe("key transparency Merkle tree (RFC 9162)", () => {
  test("every inclusion proof verifies, for trees of 1 to 40 leaves", () => {
    for (let n = 1; n <= 40; n += 1) {
      const hashes = leaves(n);
      const root = merkleRoot(hashes);
      for (let m = 0; m < n; m += 1) {
        assert.ok(verifyInclusion({ leafHash: hashes[m], index: m, size: n, proof: inclusionProof(m, hashes), root }), `n=${n} m=${m}`);
      }
    }
  });

  test("every consistency proof verifies, for all old and new sizes up to 40", () => {
    const all = leaves(40);
    for (let n = 1; n <= 40; n += 1) {
      for (let m = 1; m <= n; m += 1) {
        const proof = consistencyProof(m, all.slice(0, n));
        assert.ok(verifyConsistency({ oldSize: m, newSize: n, oldRoot: merkleRoot(all.slice(0, m)), newRoot: merkleRoot(all.slice(0, n)), proof }), `m=${m} n=${n}`);
      }
    }
  });

  test("a changed leaf, a wrong index or a wrong root fails inclusion", () => {
    const hashes = leaves(13);
    const root = merkleRoot(hashes);
    const proof = inclusionProof(5, hashes);
    assert.equal(verifyInclusion({ leafHash: hashes[6], index: 5, size: 13, proof, root }), false);
    assert.equal(verifyInclusion({ leafHash: hashes[5], index: 4, size: 13, proof, root }), false);
    assert.equal(verifyInclusion({ leafHash: hashes[5], index: 5, size: 13, proof, root: merkleRoot(leaves(12)) }), false);
    assert.equal(verifyInclusion({ leafHash: hashes[5], index: 13, size: 13, proof, root }), false);
  });

  test("a rewritten history fails consistency", () => {
    const honest = leaves(20);
    const tampered = [...honest];
    tampered[3] = leafHash(encodeKeyLeaf({ index: 3, userId: "usr_3", login: "u3", event: "key.registered", publicKey: "ATTACKER", fingerprint: "SE:X", at: 0 }));
    // A client saw the honest tree at size 10; the server now serves a tree
    // whose first 10 leaves differ.
    const proof = consistencyProof(10, tampered);
    assert.equal(verifyConsistency({ oldSize: 10, newSize: 20, oldRoot: merkleRoot(honest.slice(0, 10)), newRoot: merkleRoot(tampered), proof }), false);
    // Dropping leaves (a smaller "new" tree) fails too.
    assert.equal(verifyConsistency({ oldSize: 12, newSize: 10, oldRoot: merkleRoot(honest.slice(0, 12)), newRoot: merkleRoot(honest.slice(0, 10)), proof: [] }), false);
  });

  test("signed heads verify only with the log key and untouched fields", () => {
    const seed = new Uint8Array(32).fill(7);
    const { privateKey, publicKey } = logKeyPair(seed);
    const head = { size: 20, root: merkleRoot(leaves(20)), at: "2026-11-12T00:00:00.000Z" };
    const signed = { ...head, signature: signHead(head, privateKey) };
    assert.ok(verifyHead(signed, publicKey));
    assert.equal(verifyHead({ ...signed, size: 21 }, publicKey), false);
    assert.equal(verifyHead(signed, logKeyPair(new Uint8Array(32).fill(8)).publicKey), false);
  });
});
