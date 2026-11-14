// Client side cryptography. Nothing in this file ever runs on the server
// with real key material: the API only stores what these functions output.
//
//   secret value --AES-256-GCM(ESK, IV, AAD)--> ciphertext + auth tag
//   ESK --X25519 + HKDF-SHA-256 + AES-256-GCM--> one wrapped ESK per reader

import { gcm } from "@noble/ciphers/aes.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, fromBase64, fromUtf8, randomBytes, toBase64, toHex, utf8 } from "./bytes.js";
import { StoreEnvError } from "./errors.js";

export const ALG = "AES-256-GCM/X25519-HKDF-v1";
export const WRAP_INFO = "storeenv/wrap/v1";
export const DEVICE_INFO = "storeenv/device/v1";

const BUCKET = 32;
const IV_BYTES = 12;
const KEY_BYTES = 32;
const TAG_BYTES = 16;

export const generateEsk = () => randomBytes(KEY_BYTES);

// The additional authenticated data pins a ciphertext to its location, so a
// ciphertext can't be moved to another key, file, environment or project.
export const buildAad = ({ projectId, environment, service, name, rev }) =>
  [projectId, environment, service, name, rev].join("|");

// Values are padded to 32 byte buckets so the stored size leaks less.
const pad = (bytes) => {
  const total = Math.ceil((bytes.length + 4) / BUCKET) * BUCKET;
  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  return out;
};

const unpad = (bytes) => {
  if (bytes.length < 4) throw new Error("padding");
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (length > bytes.length - 4) throw new Error("padding");
  return bytes.subarray(4, 4 + length);
};

export const paddedSize = (value) => Math.ceil((utf8(value).length + 4) / BUCKET) * BUCKET;

export const encryptSecret = ({ esk, value, aad }) => {
  const iv = randomBytes(IV_BYTES);
  const sealed = gcm(esk, iv, utf8(aad)).encrypt(pad(utf8(value)));
  const ciphertext = sealed.subarray(0, sealed.length - TAG_BYTES);
  const authTag = sealed.subarray(sealed.length - TAG_BYTES);
  return {
    alg: ALG,
    ciphertext: toBase64(ciphertext),
    iv: toBase64(iv),
    authTag: toBase64(authTag),
    aad,
    size: ciphertext.length,
  };
};

export const decryptSecret = ({ esk, ciphertext, iv, authTag, aad }) => {
  try {
    const sealed = concatBytes(fromBase64(ciphertext), fromBase64(authTag));
    const plain = gcm(esk, fromBase64(iv), utf8(aad)).decrypt(sealed);
    return fromUtf8(unpad(plain));
  } catch {
    throw new StoreEnvError("SE_INTEGRITY");
  }
};

const deriveWrapKey = (shared, ephemeralPublic, recipientPublic, info) =>
  hkdf(sha256, shared, concatBytes(ephemeralPublic, recipientPublic), utf8(info), KEY_BYTES);

// Seals bytes to a public key: ephemeral X25519 -> HKDF -> AES-256-GCM.
// Output layout: ephemeral public key (32) | iv (12) | ciphertext + tag.
export const sealTo = (recipientPublicKey, plaintext, { info = WRAP_INFO, aad = "" } = {}) => {
  const recipient = typeof recipientPublicKey === "string" ? fromBase64(recipientPublicKey) : recipientPublicKey;
  const ephemeralSecret = x25519.utils.randomSecretKey();
  const ephemeralPublic = x25519.getPublicKey(ephemeralSecret);
  const shared = x25519.getSharedSecret(ephemeralSecret, recipient);
  const key = deriveWrapKey(shared, ephemeralPublic, recipient, info);
  const iv = randomBytes(IV_BYTES);
  const sealed = gcm(key, iv, utf8(aad)).encrypt(plaintext);
  ephemeralSecret.fill(0);
  key.fill(0);
  return toBase64(concatBytes(ephemeralPublic, iv, sealed));
};

export const openSealed = (privateKey, sealedText, { info = WRAP_INFO, aad = "" } = {}) => {
  try {
    const raw = fromBase64(sealedText);
    const ephemeralPublic = raw.subarray(0, 32);
    const iv = raw.subarray(32, 32 + IV_BYTES);
    const body = raw.subarray(32 + IV_BYTES);
    const recipientPublic = x25519.getPublicKey(privateKey);
    const shared = x25519.getSharedSecret(privateKey, ephemeralPublic);
    const key = deriveWrapKey(shared, ephemeralPublic, recipientPublic, info);
    return gcm(key, iv, utf8(aad)).decrypt(body);
  } catch {
    throw new StoreEnvError("SE_INTEGRITY", "A wrapped key failed its integrity check.");
  }
};

// A key share: the ESK of one secret wrapped to one reader's public key.
export const wrapEsk = (esk, recipientPublicKey, aad) => sealTo(recipientPublicKey, esk, { info: WRAP_INFO, aad });
export const unwrapEsk = (wrappedEsk, privateKey, aad) => openSealed(privateKey, wrappedEsk, { info: WRAP_INFO, aad });

export const generateKeyPair = () => {
  const privateKey = x25519.utils.randomSecretKey();
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
};

export const publicKeyOf = (privateKey) => x25519.getPublicKey(privateKey);

// Device enrolment: an enrolled device seals the user's private key to the
// new device's ephemeral public key. The approval code is bound as AAD.
export const sealPrivateKeyForDevice = (privateKey, devicePublicKey, code) =>
  sealTo(devicePublicKey, privateKey, { info: DEVICE_INFO, aad: code });
export const openPrivateKeyFromDevice = (sealedText, deviceSecretKey, code) =>
  openSealed(deviceSecretKey, sealedText, { info: DEVICE_INFO, aad: code });

// Derives a separate 256-bit key for one local purpose from a device key.
export const deriveKey = (ikm, info) => hkdf(sha256, ikm, undefined, utf8(info), 32);

// Local change detection uses a keyed hash that never leaves the machine.
// A plain SHA-256 of a short secret would be guessable.
export const keyedHash = (cacheKey, value) => toHex(hmac(sha256, cacheKey, utf8(value)));

// Symmetric helper used to keep the private key encrypted at rest.
export const encryptWithKey = (key, plaintext, aad = "") => {
  const iv = randomBytes(IV_BYTES);
  return toBase64(concatBytes(iv, gcm(key, iv, utf8(aad)).encrypt(plaintext)));
};

export const decryptWithKey = (key, sealedText, aad = "") => {
  try {
    const raw = fromBase64(sealedText);
    return gcm(key, raw.subarray(0, IV_BYTES), utf8(aad)).decrypt(raw.subarray(IV_BYTES));
  } catch {
    throw new StoreEnvError("SE_KEY_LOCKED");
  }
};
