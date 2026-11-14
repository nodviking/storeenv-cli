// Key transparency: an append-only Merkle tree of public-key events,
// following RFC 9162 (Certificate Transparency 2.0), section 2.1.
//
// The server appends a leaf whenever someone registers, replaces or removes
// their public key, and signs the tree head (size + root) with its log key.
// Clients keep the last head they verified and, each time they see a newer
// one, check a consistency proof: the new tree must contain the old one
// unchanged. Before encrypting for someone, they check an inclusion proof:
// the key the server hands out must be that person's latest leaf in the
// signed tree.
//
// What this gives: the server can't quietly rewrite or drop past key events
// for a client that has seen them, and can't give a client a key that isn't
// in the log it committed to. What it does not give on its own: protection
// against showing different clients different trees (a split view). That
// needs heads compared between clients or by an outside witness; the CLI's
// `storeenv verify --head` prints the head so people can compare.

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, fromBase64, toBase64, toHex, utf8 } from "./bytes.js";

const LEAF = new Uint8Array([0]);
const NODE = new Uint8Array([1]);

export const KEY_EVENTS = ["key.registered", "key.replaced", "key.removed"];
// Writer signature events (S1). Their leaves also commit to a payload: the
// account key binding, a device certificate or a revocation, as JSON text.
export const SIGNING_EVENTS = ["signing.registered", "device.added", "device.revoked"];

// The exact bytes a leaf commits to. Field order is fixed. Key events keep
// the v1 layout so existing leaves hash as before.
export const encodeKeyLeaf = ({ index, userId, login, event, publicKey, fingerprint, at, payload }) => {
  const fields = [Number(index), String(userId), String(login), String(event), publicKey ? String(publicKey) : null, fingerprint ? String(fingerprint) : null, new Date(at).toISOString()];
  if (SIGNING_EVENTS.includes(event)) return utf8(JSON.stringify(["storeenv-key-log-v2", ...fields, payload === null || payload === undefined ? null : String(payload)]));
  return utf8(JSON.stringify(["storeenv-key-log-v1", ...fields]));
};

// Checks a complete copy of the log against a signed head: every leaf from
// 0 to size - 1, in order, and nothing else. Only a complete copy shows
// that no revocation was left out; inclusion proofs can't.
export const verifyCompleteLog = (head, leaves) => {
  if (leaves.length !== Number(head.size)) return false;
  for (let i = 0; i < leaves.length; i++) if (Number(leaves[i].index) !== i) return false;
  return same(merkleRoot(leaves.map((leaf) => leafHash(encodeKeyLeaf(leaf)))), fromBase64(head.root));
};

export const leafHash = (leafBytes) => sha256(concatBytes(LEAF, leafBytes));
const nodeHash = (left, right) => sha256(concatBytes(NODE, left, right));
const largestPowerOfTwoBelow = (n) => {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
};

// MTH(D[n]) over leaf hashes.
export const merkleRoot = (hashes) => {
  if (hashes.length === 0) return sha256(new Uint8Array());
  if (hashes.length === 1) return hashes[0];
  const k = largestPowerOfTwoBelow(hashes.length);
  return nodeHash(merkleRoot(hashes.slice(0, k)), merkleRoot(hashes.slice(k)));
};

// PATH(m, D[n]).
export const inclusionProof = (m, hashes) => {
  if (m < 0 || m >= hashes.length) throw new Error("Leaf index outside the tree");
  if (hashes.length === 1) return [];
  const k = largestPowerOfTwoBelow(hashes.length);
  return m < k
    ? [...inclusionProof(m, hashes.slice(0, k)), merkleRoot(hashes.slice(k))]
    : [...inclusionProof(m - k, hashes.slice(k)), merkleRoot(hashes.slice(0, k))];
};

const subproof = (m, hashes, complete) => {
  if (m === hashes.length) return complete ? [] : [merkleRoot(hashes)];
  const k = largestPowerOfTwoBelow(hashes.length);
  return m <= k
    ? [...subproof(m, hashes.slice(0, k), complete), merkleRoot(hashes.slice(k))]
    : [...subproof(m - k, hashes.slice(k), false), merkleRoot(hashes.slice(0, k))];
};

// PROOF(m, D[n]) for 0 < m < n.
export const consistencyProof = (m, hashes) => {
  if (m <= 0 || m > hashes.length) throw new Error("Old size outside the tree");
  return m === hashes.length ? [] : subproof(m, hashes, true);
};

const same = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);

// RFC 9162 2.1.3.2.
export const verifyInclusion = ({ leafHash: leaf, index, size, proof, root }) => {
  if (index < 0 || index >= size) return false;
  let fn = index;
  let sn = size - 1;
  let r = leaf;
  for (const p of proof) {
    if (sn === 0) return false;
    if (fn & 1 || fn === sn) {
      r = nodeHash(p, r);
      if (!(fn & 1)) {
        while (!(fn & 1) && fn !== 0) {
          fn >>= 1;
          sn >>= 1;
        }
      }
    } else {
      r = nodeHash(r, p);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 && same(r, root);
};

const isPowerOfTwo = (n) => n > 0 && (n & (n - 1)) === 0;

// RFC 9162 2.1.4.2.
export const verifyConsistency = ({ oldSize, newSize, oldRoot, newRoot, proof }) => {
  if (oldSize === newSize) return proof.length === 0 && same(oldRoot, newRoot);
  if (oldSize === 0) return proof.length === 0;
  if (oldSize > newSize || proof.length === 0) return false;
  const path = isPowerOfTwo(oldSize) ? [oldRoot, ...proof] : [...proof];
  let fn = oldSize - 1;
  let sn = newSize - 1;
  while (fn & 1) {
    fn >>= 1;
    sn >>= 1;
  }
  let fr = path[0];
  let sr = path[0];
  for (const c of path.slice(1)) {
    if (sn === 0) return false;
    if (fn & 1 || fn === sn) {
      fr = nodeHash(c, fr);
      sr = nodeHash(c, sr);
      if (!(fn & 1)) {
        while (!(fn & 1) && fn !== 0) {
          fn >>= 1;
          sn >>= 1;
        }
      }
    } else {
      sr = nodeHash(sr, c);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return same(fr, oldRoot) && same(sr, newRoot) && sn === 0;
};

// Signed tree heads.
const headBytes = ({ size, root, at }) => utf8(`storeenv-key-log-head-v1\n${Number(size)}\n${typeof root === "string" ? root : toBase64(root)}\n${new Date(at).toISOString()}`);

export const logKeyPair = (seed) => ({ privateKey: seed, publicKey: ed25519.getPublicKey(seed) });
export const signHead = (head, privateKey) => toBase64(ed25519.sign(headBytes(head), privateKey));
export const verifyHead = (head, publicKey) => {
  try {
    return ed25519.verify(fromBase64(head.signature), headBytes(head), typeof publicKey === "string" ? fromBase64(publicKey) : publicKey);
  } catch {
    return false;
  }
};
export const logKeyId = (publicKey) => `LOG:${toHex(sha256(typeof publicKey === "string" ? fromBase64(publicKey) : publicKey)).slice(0, 16).toUpperCase()}`;
