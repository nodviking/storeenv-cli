import { StoreEnvError } from "@storeenv/core";
import { findEnvFiles } from "../services/filesystem.js";
import { buildManifest } from "../services/manifest.js";
import { diagnostic, line, setResult } from "../services/output.js";
import { localRoot, readProjectFile } from "../services/project.js";
import { scan } from "../services/scanner.js";

export const command = "scan";
export const describe = "Run the secret scanner without pushing";

export const handler = async () => {
  const root = localRoot();
  const settings = readProjectFile(root);
  const { files } = buildManifest(root, findEnvFiles(root, { ignore: settings.ignore || [], files: settings.files }), settings);
  if (!files.length) throw new StoreEnvError("SE_NO_ENV_FILES");
  const findings = scan(root, files);
  line(`Scanned ${files.length} env ${files.length === 1 ? "file" : "files"}, ${files.reduce((sum, file) => sum + file.entries.length, 0)} keys.`);
  for (const finding of findings) diagnostic(finding.level === "error" ? "fail" : finding.level === "warn" ? "warn" : "ok", finding.message);
  if (!findings.length) diagnostic("ok", "No problems found.");
  setResult({ files: files.map((file) => file.path), findings });
  if (findings.some((finding) => finding.level === "error")) process.exitCode = 21;
};
