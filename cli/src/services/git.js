import { execFileSync } from "node:child_process";
import path from "node:path";
import { StoreEnvError } from "@storeenv/core";

const git = (args, cwd = process.cwd()) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

const tryGit = (args, cwd) => {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
};

export const isGitRepository = (cwd) => tryGit(["rev-parse", "--is-inside-work-tree"], cwd) === "true";

export const ensureGitRepository = (cwd) => {
  if (!isGitRepository(cwd)) throw new StoreEnvError("SE_NOT_A_GIT_REPO");
};

export const getRepositoryRoot = (cwd) => {
  const root = tryGit(["rev-parse", "--show-toplevel"], cwd);
  if (!root) throw new StoreEnvError("SE_NOT_A_GIT_REPO");
  return path.resolve(root);
};

export const getRemoteOrigin = (cwd) => tryGit(["remote", "get-url", "origin"], cwd) || tryGit(["config", "--get", "remote.origin.url"], cwd);

export const getRepositoryName = (cwd) => path.basename(getRepositoryRoot(cwd));

export const getCurrentBranch = (cwd) => tryGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd) || tryGit(["symbolic-ref", "--short", "HEAD"], cwd) || "unknown";

// Env files that Git tracks are a leak waiting to happen.
export const trackedFiles = (cwd, files) => {
  if (!files.length) return [];
  const out = tryGit(["ls-files", "--", ...files], cwd);
  return out ? out.split("\n").filter(Boolean) : [];
};

export const isIgnored = (cwd, file) => {
  try {
    execFileSync("git", ["check-ignore", "-q", "--", file], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

export const clone = (url, target) => {
  execFileSync("git", ["clone", url, target], { stdio: "inherit" });
};

// The checked out branch, or null when HEAD is detached or there's no Git.
export const currentBranch = (cwd) => {
  const name = tryGit(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd);
  return name || null;
};

// Every remote's fetch URL (not just origin), without duplicates.
export const listRemotes = (cwd) => {
  const out = tryGit(["remote", "-v"], cwd);
  if (!out) return [];
  const urls = out.split("\n").filter((row) => row.endsWith("(fetch)")).map((row) => row.split(/\s+/)[1]).filter(Boolean);
  return [...new Set(urls)];
};

// The first commit of the current history; a hint, never an identity.
export const rootCommit = (cwd) => {
  const out = tryGit(["rev-list", "--max-parents=0", "HEAD"], cwd);
  return out ? out.split("\n")[0] : null;
};
