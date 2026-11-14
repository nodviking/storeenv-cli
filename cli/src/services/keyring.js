// Protects the private key at rest. The key file on disk is encrypted with
// a device key. The device key lives in the OS keychain when one exists,
// under a passphrase when STOREENV_PASSPHRASE is set, or in a 0600 file.

import { execFileSync, spawnSync } from "node:child_process";
import { scryptSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StoreEnvError, decryptWithKey, encryptWithKey, fromBase64, randomBytes, toBase64 } from "@storeenv/core";
import { homeDir, readJson, writePrivateFile } from "./config.js";

const SERVICE = "storeenv-device-key";
export const identityPath = () => path.join(homeDir(), "identity");
const deviceKeyPath = () => path.join(homeDir(), "device.key");

const has = (binary) => spawnSync(binary, ["--help"], { stdio: "ignore" }).error === undefined;

export const pickStorage = () => {
  const forced = process.env.STOREENV_KEYRING;
  if (forced) return forced;
  if (process.env.STOREENV_PASSPHRASE) return "passphrase";
  if (process.platform === "darwin") return "keychain";
  if (process.platform === "linux" && has("secret-tool")) return "secret-service";
  return "file";
};

export const describeStorage = (storage) =>
  ({ keychain: "macOS Keychain", "secret-service": "system keyring", passphrase: "encrypted file + passphrase", file: "encrypted file" }[storage] || storage);

const account = () => `storeenv:${homeDir()}`;

// A word for the command line `security -i` reads on standard input: double
// quoted, with backslash and quote escaped. A newline would end the command.
const securityWord = (value) => {
  if (/[\r\n]/.test(value)) throw new Error("a line break can't be passed to security");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
};

const keychainRead = () => execFileSync("security", ["find-generic-password", "-a", account(), "-s", SERVICE, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

const saveDeviceKey = (storage, key, salt) => {
  const encoded = toBase64(key);
  if (storage === "keychain") {
    // The key goes in on standard input (security -i), never as an argument
    // that other processes of this user could read.
    // security -i exits 0 even when the command fails, so the key is read
    // back and compared; a mismatch falls back to the encrypted file.
    const command = ["add-generic-password", "-a", securityWord(account()), "-s", securityWord(SERVICE), "-w", securityWord(encoded), "-U"].join(" ");
    execFileSync("security", ["-i"], { input: `${command}\n`, stdio: ["pipe", "ignore", "ignore"] });
    if (keychainRead() !== encoded) throw new Error("the keychain didn't store the device key");
  } else if (storage === "secret-service") {
    execFileSync("secret-tool", ["store", "--label=StoreEnv device key", "service", SERVICE, "account", account()], { input: encoded, stdio: ["pipe", "ignore", "ignore"] });
  } else if (storage === "file") {
    writePrivateFile(deviceKeyPath(), encoded);
  }
  return salt;
};

const loadDeviceKey = (storage, salt) => {
  try {
    if (storage === "keychain") {
      return fromBase64(keychainRead());
    }
    if (storage === "secret-service") {
      return fromBase64(execFileSync("secret-tool", ["lookup", "service", SERVICE, "account", account()], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
    }
    if (storage === "passphrase") {
      if (!process.env.STOREENV_PASSPHRASE) throw new Error("no passphrase");
      return new Uint8Array(scryptSync(process.env.STOREENV_PASSPHRASE, Buffer.from(salt, "base64"), 32));
    }
    return fromBase64(fs.readFileSync(deviceKeyPath(), "utf8").trim());
  } catch {
    throw new StoreEnvError("SE_KEY_LOCKED");
  }
};

const removeDeviceKey = (storage) => {
  try {
    if (storage === "keychain") execFileSync("security", ["delete-generic-password", "-a", account(), "-s", SERVICE], { stdio: "ignore" });
    else if (storage === "secret-service") execFileSync("secret-tool", ["clear", "service", SERVICE, "account", account()], { stdio: "ignore" });
    else if (storage === "file") fs.rmSync(deviceKeyPath(), { force: true });
  } catch {
    // Nothing to remove.
  }
};

export const storePrivateKey = ({ privateKey, publicKey, fingerprint, login }) => {
  let storage = pickStorage();
  const salt = toBase64(randomBytes(16));
  let deviceKey = storage === "passphrase" ? new Uint8Array(scryptSync(process.env.STOREENV_PASSPHRASE, Buffer.from(salt, "base64"), 32)) : randomBytes(32);
  try {
    saveDeviceKey(storage, deviceKey, salt);
  } catch {
    storage = "file";
    deviceKey = randomBytes(32);
    saveDeviceKey(storage, deviceKey, salt);
  }
  // The cache key makes local change detection possible without plaintext.
  const cacheKey = randomBytes(32);
  writePrivateFile(
    identityPath(),
    `${JSON.stringify({
      version: 1,
      login,
      publicKey,
      fingerprint,
      storage,
      salt,
      encryptedPrivateKey: encryptWithKey(deviceKey, privateKey, fingerprint),
      encryptedCacheKey: encryptWithKey(deviceKey, cacheKey, "cache"),
    }, null, 2)}\n`,
  );
  return storage;
};

export const readIdentityFile = () => readJson(identityPath(), null);

export const loadPrivateKey = () => {
  const file = readIdentityFile();
  if (!file?.encryptedPrivateKey) throw new StoreEnvError("SE_DEVICE_NOT_ENROLLED");
  const deviceKey = loadDeviceKey(file.storage, file.salt);
  return {
    privateKey: decryptWithKey(deviceKey, file.encryptedPrivateKey, file.fingerprint),
    cacheKey: decryptWithKey(deviceKey, file.encryptedCacheKey, "cache"),
    publicKey: file.publicKey,
    fingerprint: file.fingerprint,
    storage: file.storage,
  };
};

export const forgetIdentity = () => {
  const file = readIdentityFile();
  if (file) removeDeviceKey(file.storage);
  fs.rmSync(identityPath(), { force: true });
};

// The device signing key sits in the identity file,
// encrypted with the same device key as the private key. It never leaves
// this device; a new identity file (recover, login) starts without one.
export const storeSigningKey = (signingPrivateKey) => {
  const file = readIdentityFile();
  if (!file?.encryptedPrivateKey) throw new StoreEnvError("SE_DEVICE_NOT_ENROLLED");
  const deviceKey = loadDeviceKey(file.storage, file.salt);
  writePrivateFile(identityPath(), `${JSON.stringify({ ...file, encryptedSigningKey: encryptWithKey(deviceKey, signingPrivateKey, "signing") }, null, 2)}\n`);
};

export const loadSigningKey = () => {
  const file = readIdentityFile();
  if (!file?.encryptedSigningKey) return null;
  return decryptWithKey(loadDeviceKey(file.storage, file.salt), file.encryptedSigningKey, "signing");
};
