import fs from "node:fs";
import path from "node:path";
import { IGNORED_DIRS, isEnvFileName } from "@storeenv/core";

// Returns repository relative paths with forward slashes, sorted.
// files: paths mapped in .storeenv.json, included whatever their name.
export const findEnvFiles = (rootPath, { ignore = [], files = {} } = {}) => {
  const ignored = new Set([...IGNORED_DIRS, ...ignore.map((item) => item.replace(/\/+$/, ""))]);
  const found = [];

  const walk = (dir, relative) => {
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const rel = relative ? `${relative}/${item.name}` : item.name;
      if (ignored.has(item.name) || ignored.has(rel)) continue;
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) walk(path.join(dir, item.name), rel);
      else if (item.isFile() && isEnvFileName(item.name)) found.push(rel);
    }
  };

  walk(rootPath, "");
  for (const rel of Object.keys(files || {})) {
    if (found.includes(rel)) continue;
    const full = path.join(rootPath, rel);
    try {
      const stat = fs.lstatSync(full);
      if (stat.isFile() && !stat.isSymbolicLink()) found.push(rel);
    } catch {
      // A mapped file that doesn't exist yet is simply not there.
    }
  }
  return found.sort();
};

export const readEnv = (filePath) => fs.readFileSync(filePath, "utf8");

export const exists = (filePath) => fs.existsSync(filePath);
