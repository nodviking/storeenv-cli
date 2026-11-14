import fs from "node:fs";
import { CLIENT_VERSION, api } from "../services/api.js";
import { apiBase, configPath, readConfig } from "../services/config.js";
import { findEnvFiles } from "../services/filesystem.js";
import { isGitRepository, listRemotes } from "../services/git.js";
import { PROJECT_FILE, findProjectFile, loadProjectFile } from "../services/projectfile.js";
import { hasLocalIdentity, loadIdentity } from "../services/identity.js";
import { buildManifest } from "../services/manifest.js";
import { diagnostic, setResult } from "../services/output.js";
import { localRoot, readProjectFile } from "../services/project.js";
import { scan } from "../services/scanner.js";
import { accountState, deviceKey, syncLog } from "../services/signing.js";

export const command = "doctor";
export const describe = "Diagnose config, network, identity and repository";

export const handler = async () => {
  const checks = [];
  const report = (level, text) => {
    checks.push({ level, text });
    diagnostic(level, text);
  };

  report("ok", `CLI ${CLIENT_VERSION} on Node ${process.versions.node}`);

  let reachable = false;
  try {
    await api.health();
    reachable = true;
    report("ok", `API reachable at ${apiBase()}`);
  } catch {
    report("fail", `API unreachable at ${apiBase()} (proxy?)  -> see storeenv.app/docs/network`);
  }

  const config = readConfig();
  if (process.platform !== "win32" && fs.existsSync(configPath()) && (fs.statSync(configPath()).mode & 0o077) !== 0) {
    report("warn", `${configPath()} is readable by other users. Run: chmod 600 ${configPath()}`);
  }
  let user = null;
  if (!config.token) report("fail", "Not signed in  -> run storeenv login");
  else if (reachable) {
    try {
      user = (await api.me()).user;
      report("ok", `Signed in as @${user.login}`);
    } catch (error) {
      report("fail", `Session invalid (${error.code})  -> run storeenv login`);
    }
  }

  let identity = null;
  if (!hasLocalIdentity()) report(user?.hasIdentity ? "fail" : "warn", "No identity on this device  -> run storeenv login or storeenv recover");
  else {
    try {
      identity = loadIdentity();
      if (user?.fingerprint && user.fingerprint !== identity.fingerprint) {
        report("fail", "This device holds a key for a different identity  -> run storeenv recover");
        identity = null;
      } else report("ok", `Identity unlocked via ${identity.storageLabel}  ${identity.fingerprint}`);
    } catch {
      report("fail", "Identity is locked  -> unlock your OS keychain or set STOREENV_PASSPHRASE");
    }
  }

  // Writer signatures: run, copy and pull depend on the key log and on this
  // device's signing key, so their state is part of a diagnosis.
  if (identity && user) {
    try {
      const { head, leaves } = await syncLog(identity);
      report("ok", `Key log verified: ${head.size} ${head.size === 1 ? "entry" : "entries"}, signed ${new Date(head.at).toISOString()} by ${head.logKeyId}`);
      const state = accountState(leaves, user.id);
      const mine = deviceKey();
      if (mine && state.revoked.has(mine.publicKeyBase64)) report("fail", `This device's signing key ${mine.keyId} was revoked  -> storeenv keys signing-setup`);
      else if (mine && state.devices.has(mine.publicKeyBase64)) report("ok", `This device signs as ${mine.keyId}`);
      else if (!state.accountKey) report("warn", "Writer signing isn't set up for your account; your pushes are unsigned  -> storeenv keys signing-setup");
      else report("warn", "This device can't sign yet; its pushes are unsigned  -> storeenv keys signing-setup");
    } catch (error) {
      report("fail", `Key log: ${error.message}${error.hint ? `  -> ${error.hint}` : ""}`);
    }
  }

  // Git is optional: it only adds remote hints and .gitignore checks.
  const root = localRoot();
  const found = findProjectFile(process.cwd());
  if (found) {
    try {
      const { config } = loadProjectFile(found.file);
      report(config.project ? "ok" : "warn", config.project ? `${PROJECT_FILE}: ${config.name || config.project}` : `${PROJECT_FILE} has no project yet  -> storeenv link <namespace/name>`);
    } catch (error) {
      report("fail", `${error.message}  -> ${error.hint}`);
    }
  } else report("warn", `No ${PROJECT_FILE} here  -> storeenv init or storeenv link <namespace/name>`);
  if (isGitRepository(process.cwd())) {
    const remotes = listRemotes(process.cwd());
    report("ok", remotes.length ? `Git repository: ${remotes.join(", ")}` : "Git repository without a remote");
  }
  {
    let settings = {};
    try {
      settings = readProjectFile(root);
    } catch {
      settings = {};
    }
    const { files } = buildManifest(root, findEnvFiles(root, { ignore: settings.ignore || [], files: settings.files }), settings);
    if (!files.length) report("warn", "No .env files found");
    for (const finding of scan(root, files)) {
      if (finding.level === "info") continue;
      report(finding.level === "error" ? "fail" : "warn", finding.message);
    }
  }

  setResult({ checks });
  if (checks.some((check) => check.level === "fail")) process.exitCode = 1;
};
