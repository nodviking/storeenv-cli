// XEdDSA (Signal, "The XEdDSA and VXEdDSA Signature Schemes", 2016):
// Ed25519 compatible signatures made with an X25519 private key, checked
// against the X25519 public key. StoreEnv uses it once per identity: the
// account's X25519 key vouches for its account signing key, so only a
// holder of the identity key (never the server) can register one.

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { concatBytes, randomBytes } from "./bytes.js";

const Point = ed25519.Point;
const Fn = Point.Fn;
const Fp = Point.Fp;

const toNumberLE = (bytes) => {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
  return n;
};
const toBytesLE = (n, length = 32) => {
  const out = new Uint8Array(length);
  let value = n;
  for (let i = 0; i < length; i++) {
    out[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
};

// hash_1 of the paper: a domain prefix of 0xFE followed by 31 bytes 0xFF.
const HASH1 = (() => {
  const prefix = new Uint8Array(32).fill(0xff);
  prefix[0] = 0xfe;
  return prefix;
})();

export const xeddsaSign = (x25519PrivateKey, message) => {
  const clamped = Uint8Array.from(x25519PrivateKey);
  clamped[0] &= 248;
  clamped[31] &= 127;
  clamped[31] |= 64;
  let a = Fn.create(toNumberLE(clamped));
  let A = Point.BASE.multiply(a);
  // The public key always has sign bit 0; negate the scalar when needed.
  if (A.toBytes()[31] & 0x80) {
    a = Fn.neg(a);
    A = A.negate();
  }
  const r = Fn.create(toNumberLE(sha512(concatBytes(HASH1, toBytesLE(a), message, randomBytes(64)))));
  const R = Point.BASE.multiply(r);
  const h = Fn.create(toNumberLE(sha512(concatBytes(R.toBytes(), A.toBytes(), message))));
  const s = Fn.add(r, Fn.mul(h, a));
  clamped.fill(0);
  return concatBytes(R.toBytes(), toBytesLE(s));
};

// The Edwards public key with sign bit 0 that matches an X25519 public key:
// y = (u - 1) / (u + 1).
export const xeddsaPublicKey = (x25519PublicKey) => {
  const bytes = Uint8Array.from(x25519PublicKey);
  bytes[31] &= 127;
  const u = Fp.create(toNumberLE(bytes));
  if (u === Fp.ORDER - 1n) throw new Error("not a usable X25519 public key");
  const y = Fp.mul(Fp.sub(u, 1n), Fp.inv(Fp.add(u, 1n)));
  const out = toBytesLE(y);
  out[31] &= 127;
  return out;
};

export const xeddsaVerify = (x25519PublicKey, message, signature) => {
  try {
    return ed25519.verify(signature, message, xeddsaPublicKey(x25519PublicKey));
  } catch {
    return false;
  }
};
