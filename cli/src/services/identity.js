// The device's copy of the user's identity. The key pair comes from the
// recovery phrase, or from another enrolled device through an approval code.

import os from "node:os";
import {
  StoreEnvError, checkDeviceKey, checkOwnKey, deriveIdentity, fingerprintOf, generateKeyPair, identityFromPrivateKey, normalizeCode,
  openPrivateKeyFromDevice, sealPrivateKeyForDevice, toBase64,
} from "@storeenv/core";
import { api } from "./api.js";
import { readConfig } from "./config.js";
import { describeStorage, loadPrivateKey, readIdentityFile, storePrivateKey, storeSigningKey } from "./keyring.js";
import { checkLog } from "./trust.js";

export const deviceInfo = () => ({
  deviceName: process.env.STOREENV_DEVICE_NAME || os.hostname().replace(/\.local$/, ""),
  os: { darwin: "macOS", linux: "Linux", win32: "Windows" }[process.platform] || process.platform,
});

let cached = null;

export const hasLocalIdentity = () => Boolean(readIdentityFile()?.encryptedPrivateKey);

// Loads the unlocked identity for this process.
export const loadIdentity = () => {
  if (cached) return cached;
  const loaded = loadPrivateKey();
  cached = { ...identityFromPrivateKey(loaded.privateKey), cacheKey: loaded.cacheKey, storage: loaded.storage, storageLabel: describeStorage(loaded.storage) };
  return cached;
};

export const resetIdentityCache = () => {
  cached = null;
};

// Makes sure this device can decrypt for the signed in account.
export const requireIdentity = (user) => {
  if (user && !user.hasIdentity) throw new StoreEnvError("SE_IDENTITY_MISSING");
  const identity = loadIdentity();
  if (user?.fingerprint && user.fingerprint !== identity.fingerprint) {
    throw new StoreEnvError("SE_DEVICE_NOT_ENROLLED", "This device holds a key for a different identity.", { hint: "Run: storeenv recover" });
  }
  return identity;
};

const saveIdentity = (identity) => {
  const storage = storePrivateKey({
    privateKey: identity.privateKey,
    publicKey: identity.publicKeyBase64,
    fingerprint: identity.fingerprint,
    login: readConfig().login,
  });
  resetIdentityCache();
  return storage;
};

// Restores the same key pair from the 24 word recovery phrase.
export const recoverIdentity = async (phrase, expectedFingerprint) => {
  const identity = deriveIdentity(phrase);
  if (expectedFingerprint && identity.fingerprint !== expectedFingerprint) {
    throw new StoreEnvError("SE_FINGERPRINT_MISMATCH", "This phrase belongs to a different identity.", { hint: "Check that you're signed in to the right account" });
  }
  const storage = saveIdentity(identity);
  await api.enrollDevice({ fingerprint: identity.fingerprint, storage: describeStorage(storage), kind: "cli", ...deviceInfo(), name: deviceInfo().deviceName });
  return { identity, storage };
};

export const newDeviceKeys = () => {
  const pair = generateKeyPair();
  return { secretKey: pair.privateKey, publicKey: toBase64(pair.publicKey) };
};

// Waits for an enrolled device (or the browser) to hand over the private key.
export const waitForApproval = async ({ code, secretKey, signingKey = null, userId, timeoutMs = 5 * 60_000, intervalMs = 1500, onTick }) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let request;
    try {
      request = await api.deviceRequest(code);
    } catch (error) {
      if (error.code === "SE_NOT_FOUND") throw new StoreEnvError("SE_DEVICE_NOT_ENROLLED", "The approval code expired.", { hint: "Run storeenv login again, or storeenv recover" });
      throw error;
    }
    if (request.status === "denied") throw new StoreEnvError("SE_DEVICE_NOT_ENROLLED", "The request was denied from another device.");
    if (request.status === "approved" && request.wrappedPrivateKey) {
      const privateKey = openPrivateKeyFromDevice(request.wrappedPrivateKey, secretKey, normalizeCode(code));
      const identity = identityFromPrivateKey(privateKey);
      // The server names the expected fingerprint. A different key means
      // something on the path swapped it.
      if (request.fingerprint && request.fingerprint !== identity.fingerprint) throw new StoreEnvError("SE_FINGERPRINT_MISMATCH");
      // The server could also hand over a key it made itself, with a matching
      // fingerprint. Accept it only if it is this account's logged key.
      const { leaves } = await checkLog(identity, [userId], { quiet: true });
      checkOwnKey({ leaves, userId, publicKey: identity.publicKeyBase64 });
      const storage = saveIdentity(identity);
      // The approver may have certified it; either way it is this device's.
      if (signingKey) storeSigningKey(signingKey);
      await api.enrollDevice({ fingerprint: identity.fingerprint, storage: describeStorage(storage), kind: "cli", name: deviceInfo().deviceName, os: deviceInfo().os }).catch(() => {});
      return { identity, storage };
    }
    onTick?.();
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new StoreEnvError("SE_DEVICE_NOT_ENROLLED", "Timed out waiting for approval.", { hint: "Run storeenv login again, or storeenv recover" });
};

// Called on an enrolled device: seals the private key to the new device, but
// only to the device key the person read off that device, and only while
// this identity is still the account's logged key.
export const approveDevice = async (code, { userId } = {}) => {
  const identity = loadIdentity();
  const request = await api.deviceRequest(code);
  if (request.status !== "pending") throw new StoreEnvError("SE_CONFLICT", "This request was already handled.");
  return {
    request,
    // certify(signingKey) -> certificate or null, from signing.certifyOther.
    approve: async (deviceKey, { certify } = {}) => {
      checkDeviceKey(request, deviceKey);
      const { leaves } = await checkLog(identity, [userId], { quiet: true });
      checkOwnKey({ leaves, userId, publicKey: identity.publicKeyBase64 });
      const wrapped = sealPrivateKeyForDevice(identity.privateKey, request.ephemeralPublicKey, request.code);
      const certificate = request.signingKey && certify ? await certify(request.signingKey, request.deviceName) : null;
      await api.approveDevice(request.code, wrapped, certificate);
      return { certified: Boolean(certificate) };
    },
    deny: () => api.denyDevice(request.code),
  };
};

export const fingerprintMatches = (publicKey, fingerprint) => fingerprintOf(publicKey) === fingerprint;
