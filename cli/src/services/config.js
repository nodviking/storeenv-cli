import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_API = "https://api.storeenv.app";

// Everything the CLI keeps lives in one folder. STOREENV_HOME moves it,
// which the tests and CI runners rely on.
export const homeDir = () => process.env.STOREENV_HOME || path.join(os.homedir(), ".storeenv");
export const configPath = () => path.join(homeDir(), "config.json");

export const ensureHome = () => {
  fs.mkdirSync(homeDir(), { recursive: true, mode: 0o700 });
};

export const writePrivateFile = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  fs.renameSync(temp, file);
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
};

export const readJson = (file, fallback = null) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};

export const ensureConfig = () => {
  ensureHome();
  if (!fs.existsSync(configPath())) writePrivateFile(configPath(), "{}\n");
};

export const readConfig = () => {
  ensureConfig();
  return readJson(configPath(), {}) || {};
};

export const writeConfig = (data) => {
  ensureHome();
  writePrivateFile(configPath(), `${JSON.stringify(data, null, 2)}\n`);
};

export const updateConfig = (changes) => {
  const next = { ...readConfig(), ...changes };
  writeConfig(next);
  return next;
};

export const deleteConfig = () => {
  if (fs.existsSync(configPath())) fs.unlinkSync(configPath());
};

let apiOverride = null;
export const setApiOverride = (url) => {
  apiOverride = url ? String(url).replace(/\/$/, "") : null;
};

export const apiBase = () =>
  (apiOverride || process.env.STOREENV_API || readConfig().apiUrl || DEFAULT_API).replace(/\/$/, "");
