import { scan as scanText } from "@storeenv/core";
import { isGitRepository, isIgnored, trackedFiles } from "./git.js";

// Scans parsed manifest files and adds repository level checks.
export const scan = (root, files) => {
  const findings = files.flatMap((file) => scanText(file.text, { file: file.path }));
  const paths = files.map((file) => file.path);
  // Git checks only mean something inside a Git repository.
  if (!isGitRepository(root)) return findings;
  let tracked = [];
  try {
    tracked = trackedFiles(root, paths);
  } catch {
    tracked = [];
  }
  for (const file of tracked) {
    findings.push({ level: "warn", type: "tracked", file, message: `${file} is tracked by Git. Remove it with: git rm --cached ${file}` });
  }
  for (const file of paths) {
    if (tracked.includes(file)) continue;
    let ignored = true;
    try {
      ignored = isIgnored(root, file);
    } catch {
      ignored = true;
    }
    if (!ignored) findings.push({ level: "warn", type: "not-ignored", file, message: `${file} isn't covered by .gitignore` });
  }
  return findings;
};

export const blocking = (findings) => findings.filter((finding) => finding.level === "error");
export const warnings = (findings) => findings.filter((finding) => finding.level === "warn");
