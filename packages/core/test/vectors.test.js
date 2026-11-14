// The protocol test vectors (test/vectors/vectors.json) against this
// implementation: every
// deterministic value is recomputed, randomized ones are verified, and a
// changed byte makes each verification fail.

import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import {
  checkVersionManifest, decryptSecret, verifyAccountBinding, verifyCertSignature, verifyCompleteLog, verifyEntrySignature, verifyHead,
  verifyRevocationSignature, verifyVersionSignature,
} from "../src/index.js";
import { fromBase64 } from "../src/bytes.js";
import { buildVectors } from "./vectors/build.js";

const vectors = JSON.parse(fs.readFileSync(new URL("./vectors/vectors.json", import.meta.url), "utf8"));
const flip = (b64) => {
  const bytes = fromBase64(b64);
  bytes[0] ^= 1;
  return Buffer.from(bytes).toString("base64");
};

test("every deterministic vector is what the implementation produces", () => {
  assert.deepEqual(buildVectors(vectors), vectors, "run: node test/vectors/build.js > test/vectors/vectors.json, and review the diff");
});

test("the stored randomized values verify", () => {
  assert.equal(verifyAccountBinding(vectors.accountBinding), true);
  const value = decryptSecret({ esk: fromBase64(vectors.secret.esk), ciphertext: vectors.secret.ciphertext, iv: vectors.secret.iv, authTag: vectors.secret.authTag, aad: vectors.secret.aad });
  assert.equal(value, vectors.secret.value);
});

test("signatures verify and a changed byte breaks each one", () => {
  const { entry, version, deviceCertificate: cert, deviceRevocation: revocation, accountBinding: binding, keyLog } = vectors;
  const at = { projectId: entry.projectId, environment: entry.environment, service: entry.service };
  assert.equal(verifyEntrySignature(entry, at), true);
  assert.equal(verifyEntrySignature({ ...entry, ciphertext: flip(entry.ciphertext) }, at), false);
  assert.equal(verifyEntrySignature(entry, { ...at, environment: "staging" }), false, "an entry is bound to its environment");
  assert.equal(verifyVersionSignature(version), true);
  assert.equal(verifyVersionSignature({ ...version, parent: "ver_other" }), false);
  assert.equal(checkVersionManifest(version, [{ service: "api", path: "api/.env", entries: [entry] }]), true);
  assert.equal(verifyCertSignature(cert), true);
  assert.equal(verifyCertSignature({ ...cert, deviceName: "other" }), false);
  assert.equal(verifyRevocationSignature(revocation), true);
  assert.equal(verifyRevocationSignature({ ...revocation, revokedAt: "2026-01-02T00:00:00.000Z" }), false);
  assert.equal(verifyAccountBinding({ ...binding, identityProof: flip(binding.identityProof) }), false);
  assert.equal(verifyHead(keyLog.head, vectors.keys.logPublicKey), true);
  assert.equal(verifyHead({ ...keyLog.head, size: 4 }, vectors.keys.logPublicKey), false);
  assert.equal(verifyCompleteLog(keyLog.head, keyLog.leaves), true);
  assert.equal(verifyCompleteLog(keyLog.head, keyLog.leaves.slice(0, 2)), false, "a log copy missing a leaf is refused");
});

test("decryption fails when the value is moved to another location", () => {
  const s = vectors.secret;
  assert.throws(() => decryptSecret({ esk: fromBase64(s.esk), ciphertext: s.ciphertext, iv: s.iv, authTag: s.authTag, aad: s.aad.replace("production", "staging") }));
});
