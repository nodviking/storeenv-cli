import { StoreEnvError, shortId } from "@storeenv/core";
import { findCommit, restoreCommit } from "../services/commits.js";
import { hasLocalIdentity, loadIdentity } from "../services/identity.js";
import { added, dim, line, setResult, success } from "../services/output.js";
import { confirm } from "../services/prompt.js";
import { localRoot, readProjectFile } from "../services/project.js";

export const command = "restore <commit>";
export const describe = "Write the env files saved in a local commit back to disk (works offline)";
export const builder = (yargs) => yargs.positional("commit", { type: "string", describe: "Local commit id from storeenv log --local" });

export const handler = async (argv) => {
  if (!hasLocalIdentity()) throw new StoreEnvError("SE_DEVICE_NOT_ENROLLED", "This device has no StoreEnv key yet.", { hint: "Run storeenv login once while online" });
  const root = localRoot();
  const commit = findCommit(root, argv.commit);
  if (!(await confirm(`Restore your env files to local commit ${shortId(commit.id)} "${commit.message}"? Changed files are backed up.`, true))) {
    line("Nothing was changed.");
    return;
  }
  const written = restoreCommit(root, commit, loadIdentity(), readProjectFile(root));
  if (!written.length) line("Your env files already match that commit.");
  for (const file of written) line(added(`${file.path}${file.backup ? dim(`   backup: ${file.backup}`) : ""}`));
  if (written.length) success(`Restored ${written.length} ${written.length === 1 ? "file" : "files"} from ${shortId(commit.id)}.`);
  setResult({ restored: written });
};
