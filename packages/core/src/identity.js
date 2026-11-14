// A user's cryptographic identity.
// 24 word recovery phrase (256 bit root seed) -> HKDF-SHA-256 -> X25519 key pair.
// The same phrase gives the same key pair on every device. The phrase is
// never sent to StoreEnv.

import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { generateMnemonic, mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { fromBase64, toBase64, toHex, utf8 } from "./bytes.js";
import { StoreEnvError } from "./errors.js";

export const IDENTITY_INFO = "storeenv/identity/v1";
export const IDENTITY_ALG = "X25519";
export const WORD_COUNT = 24;
export const WORDLIST = wordlist;

export const generatePhrase = () => generateMnemonic(wordlist, 256);

export const normalizePhrase = (phrase) =>
  String(phrase || "").toLowerCase().trim().split(/[\s,]+/).filter(Boolean).join(" ");

export const isValidPhrase = (phrase) => {
  const normal = normalizePhrase(phrase);
  return normal.split(" ").length === WORD_COUNT && validateMnemonic(normal, wordlist);
};

export const isKnownWord = (word) => wordlist.includes(String(word || "").toLowerCase().trim());

export const suggestWords = (prefix, limit = 5) => {
  const start = String(prefix || "").toLowerCase().trim();
  if (!start) return [];
  return wordlist.filter((word) => word.startsWith(start)).slice(0, limit);
};

export const fingerprintOf = (publicKey) => {
  const bytes = typeof publicKey === "string" ? fromBase64(publicKey) : publicKey;
  const hex = toHex(sha256(bytes).subarray(0, 6)).toUpperCase();
  return `SE:${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
};

export const identityFromPrivateKey = (privateKey) => {
  const publicKey = x25519.getPublicKey(privateKey);
  return {
    alg: IDENTITY_ALG,
    privateKey,
    publicKey,
    publicKeyBase64: toBase64(publicKey),
    fingerprint: fingerprintOf(publicKey),
  };
};

export const deriveIdentity = (phrase) => {
  const normal = normalizePhrase(phrase);
  if (!isValidPhrase(normal)) {
    throw new StoreEnvError("SE_INVALID", "That recovery phrase isn't valid. Check each word and the order.");
  }
  const seed = mnemonicToEntropy(normal, wordlist);
  const privateKey = hkdf(sha256, seed, undefined, utf8(IDENTITY_INFO), 32);
  seed.fill(0);
  return identityFromPrivateKey(privateKey);
};

// Picks the word positions a new user must confirm (1 based, sorted).
export const pickVerifyPositions = (count = 3, random = Math.random) => {
  const positions = new Set();
  while (positions.size < count) positions.add(1 + Math.floor(random() * WORD_COUNT));
  return [...positions].sort((a, b) => a - b);
};
