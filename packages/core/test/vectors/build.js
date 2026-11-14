// Builds the public test vectors (vectors.json) from fixed, test only inputs.
// Every deterministic value is recomputed by the tests and must match byte
// for byte. Two values are randomized by design (the XEdDSA proof and an
// AES-GCM nonce); for those the file keeps one fixed sample and the tests
// verify it instead.
//
// NOTHING HERE IS A REAL KEY. The phrase comes from the entropy 00 01 .. 1f.
//
//   node test/vectors/build.js > test/vectors/vectors.json

import { gcm } from "@noble/ciphers/aes.js";
import { entropyToMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import {
  buildAad, canonical, certifyDevice, deriveAccountSigningKey, deriveIdentity, deviceSigningKeyFrom, encodeKeyLeaf, fileDigest,
  leafHash, logKeyPair, merkleRoot, revokeDevice, signAccountBinding, signEntry, signHead, signVersion, signingKeyId,
} from "../../src/index.js";
import { fromBase64, toBase64, toHex, utf8 } from "../../src/bytes.js";

const seq = (start, length = 32) => Uint8Array.from({ length }, (_, i) => (start + i) & 0xff);
export const TEST_PHRASE = entropyToMnemonic(seq(0), wordlist);

// Value padding (spec section "Values"): a 4 byte big endian length, the
// UTF-8 bytes, zeros up to a multiple of 32. Written out here independently
// of src/crypto.js, so the vector checks the implementation against the text.
const pad = (bytes) => {
  const out = new Uint8Array(Math.ceil((bytes.length + 4) / 32) * 32);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  return out;
};

export const buildVectors = (previous = null) => {
  const identity = deriveIdentity(TEST_PHRASE);
  const account = deriveAccountSigningKey(TEST_PHRASE);
  const device = deviceSigningKeyFrom(seq(0x40));
  const log = logKeyPair(seq(0x80));
  const userId = "usr_vector";
  const at = "2026-01-01T00:00:00.000Z";

  const canonicalCase = { domain: "storeenv/example/v1", fields: ["a", "", null, 42, "ünï"] };

  const binding = signAccountBinding({ userId, publicKey: identity.publicKeyBase64 }, account, identity.privateKey);
  const keepProof = previous?.accountBinding?.identityProof;

  const cert = certifyDevice({ userId, accountKey: account.publicKeyBase64, deviceKey: device.publicKeyBase64, deviceName: "laptop", issuedAt: at }, account);
  const revocation = revokeDevice({ userId, accountKey: account.publicKeyBase64, deviceKey: device.publicKeyBase64, revokedAt: at }, account);

  const location = { projectId: "prj_vector", environment: "production", service: "api", name: "DATABASE_URL", rev: 3 };
  const aad = buildAad(location);
  const esk = seq(0xa0);
  const iv = previous?.secret?.iv ? fromBase64(previous.secret.iv) : seq(0xc0, 12);
  const value = "postgres://example.invalid/db";
  const sealed = gcm(esk, iv, utf8(aad)).encrypt(pad(utf8(value)));
  const secret = {
    esk: toBase64(esk), value, aad, iv: toBase64(iv),
    ciphertext: toBase64(sealed.subarray(0, sealed.length - 16)), authTag: toBase64(sealed.subarray(sealed.length - 16)),
    alg: "AES-256-GCM/X25519-HKDF-v1",
  };

  const entry = signEntry(
    { id: "ent_vector", name: location.name, rev: location.rev, alg: secret.alg, aad, iv: secret.iv, ciphertext: secret.ciphertext, authTag: secret.authTag },
    { projectId: location.projectId, environment: location.environment, service: location.service, userId },
    device,
  );
  const file = { service: "api", path: "api/.env", entries: [entry] };
  const digest = fileDigest(file);
  const version = { id: "ver_vector", parent: null, projectId: location.projectId, environment: location.environment, kind: "push", manifest: [digest] };
  const versionSig = signVersion(version, { userId }, device);

  const leaves = [
    { index: 0, userId, login: "vector", event: "key.registered", publicKey: identity.publicKeyBase64, fingerprint: identity.fingerprint, at },
    { index: 1, userId, login: "vector", event: "signing.registered", publicKey: null, fingerprint: null, at, payload: JSON.stringify({ accountKey: account.publicKeyBase64 }) },
    { index: 2, userId, login: "vector", event: "device.added", publicKey: null, fingerprint: null, at, payload: JSON.stringify(cert) },
  ];
  const hashes = leaves.map((leaf) => leafHash(encodeKeyLeaf(leaf)));
  const head = { size: leaves.length, root: toBase64(merkleRoot(hashes)), at };

  return {
    note: "StoreEnv protocol test vectors. Test only inputs; nothing here is a real key.",
    canonical: { ...canonicalCase, hex: toHex(canonical(canonicalCase.domain, canonicalCase.fields)) },
    keys: {
      phraseEntropyHex: toHex(seq(0)),
      phrase: TEST_PHRASE,
      identityPublicKey: identity.publicKeyBase64,
      identityFingerprint: identity.fingerprint,
      accountSigningPublicKey: account.publicKeyBase64,
      accountSigningKeyId: signingKeyId(account.publicKey),
      deviceSigningSeedHex: toHex(seq(0x40)),
      deviceSigningPublicKey: device.publicKeyBase64,
      logSeedHex: toHex(seq(0x80)),
      logPublicKey: toBase64(log.publicKey),
    },
    accountBinding: { ...binding, identityProof: keepProof || binding.identityProof },
    deviceCertificate: cert,
    deviceRevocation: revocation,
    secret,
    entry: { ...entry, projectId: location.projectId, environment: location.environment, service: location.service },
    file: { service: file.service, path: file.path, entryIds: [entry.id], digest },
    version: { ...version, ...versionSig },
    keyLog: {
      leaves,
      leafEncodings: leaves.map((leaf) => new TextDecoder().decode(encodeKeyLeaf(leaf))),
      leafHashesHex: hashes.map(toHex),
      head: { ...head, signature: signHead(head, log.privateKey) },
    },
  };
};

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const fs = await import("node:fs");
  const target = new URL("./vectors.json", import.meta.url);
  const previous = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, "utf8")) : null;
  process.stdout.write(`${JSON.stringify(buildVectors(previous), null, 2)}\n`);
}
