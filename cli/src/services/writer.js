import fs from "node:fs";
import path from "node:path";

export const BACKUP_SUFFIX = ".storeenv-backup";

// Refuses paths that would land outside the repository.
export const resolveInside = (root, relativePath) => {
  const target = path.resolve(root, relativePath);
  const base = path.resolve(root);
  if (target !== base && !target.startsWith(base + path.sep)) throw new Error(`Refusing to write outside the repository: ${relativePath}`);
  // Never inside Git's own folder, whatever named the path.
  if (path.relative(base, target).split(path.sep).includes(".git")) throw new Error(`Refusing to write inside .git: ${relativePath}`);
  return target;
};

export const backupExisting = (root, relativePath) => {
  const target = resolveInside(root, relativePath);
  if (!fs.existsSync(target)) return null;
  const backup = `${target}${BACKUP_SUFFIX}`;
  fs.copyFileSync(target, backup);
  if (process.platform !== "win32") fs.chmodSync(backup, 0o600);
  return `${relativePath}${BACKUP_SUFFIX}`;
};

// Atomic write: a reader sees the old file or the new file in full.
export const writeEnvFile = (root, relativePath, text) => {
  const target = resolveInside(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  fs.renameSync(temp, target);
  if (process.platform !== "win32") fs.chmodSync(target, 0o600);
};
