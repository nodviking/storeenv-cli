// Reading and writing .storeenv.json (format rules live in @storeenv/core).

import fs from "node:fs";
import path from "node:path";
import { StoreEnvError, parseProjectConfig, serializeProjectConfig } from "@storeenv/core";
import { homeDir, readJson, writePrivateFile } from "./config.js";
import { info } from "./output.js";

export const PROJECT_FILE = ".storeenv.json";

// The nearest .storeenv.json from dir upwards, or null.
export const findProjectFile = (start = process.cwd()) => {
  let dir = path.resolve(start);
  for (;;) {
    const file = path.join(dir, PROJECT_FILE);
    if (fs.existsSync(file)) return { dir, file };
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};

const shown = new Set();
export const loadProjectFile = (file) => {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new StoreEnvError("SE_CONFIG_INVALID", `Can't read ${file}: ${error.message}`);
  }
  let parsed;
  try {
    parsed = parseProjectConfig(text);
  } catch (error) {
    error.message = `${error.message} (${file})`;
    throw error;
  }
  for (const notice of parsed.notices) {
    if (!shown.has(notice)) info(notice);
    shown.add(notice);
  }
  return parsed;
};

// Settings for a folder: an empty v2 config when there is no file.
export const readSettings = (dir) => {
  const file = path.join(dir, PROJECT_FILE);
  return fs.existsSync(file) ? loadProjectFile(file).config : { version: 2, files: {}, branches: {}, imports: [] };
};

// Validates, keeps a one time backup of a v1 file, then replaces atomically.
export const saveProjectFile = (dir, config) => {
  const file = path.join(dir, PROJECT_FILE);
  if (fs.existsSync(file)) {
    const current = loadProjectFile(file);
    if (current.readOnly) throw new StoreEnvError("SE_CONFIG_INVALID", `${file} was written by a newer StoreEnv CLI.`, { hint: "Update the CLI: npm i -g storeenv-cli" });
    if (current.sourceVersion < 2 && !fs.existsSync(`${file}.bak`)) fs.copyFileSync(file, `${file}.bak`);
  }
  const text = serializeProjectConfig(config);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text);
  fs.renameSync(temp, file);
  return file;
};

// Per machine, never committed: "storeenv env use" choices by folder.
const statePath = () => path.join(homeDir(), "folders.json");
export const chosenEnvironment = (dir) => readJson(statePath(), {})?.[path.resolve(dir)]?.env || null;
export const chooseEnvironment = (dir, env) => {
  const state = readJson(statePath(), {}) || {};
  const key = path.resolve(dir);
  if (env) state[key] = { ...(state[key] || {}), env };
  else delete state[key];
  writePrivateFile(statePath(), `${JSON.stringify(state, null, 2)}\n`);
};
