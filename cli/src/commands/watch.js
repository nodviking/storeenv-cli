import fs from "node:fs";
import path from "node:path";
import { findEnvFiles } from "../services/filesystem.js";
import { dim, line, printError } from "../services/output.js";
import { configurePrompt } from "../services/prompt.js";
import { openProject } from "../services/session.js";
import { handler as push } from "./push.js";

export const command = "watch";
export const describe = "Push automatically when an env file changes";
export const builder = (yargs) => yargs.option("interval", { type: "number", default: 2, describe: "Seconds between checks" });

const snapshot = (root, ignore, files) =>
  findEnvFiles(root, { ignore, files })
    .map((file) => {
      const stat = fs.statSync(path.join(root, file));
      return `${file}:${stat.mtimeMs}:${stat.size}`;
    })
    .join("|");

export const handler = async (argv) => {
  const { root, settings, project } = await openProject(argv, { create: true, identity: true });
  configurePrompt({ yes: true });
  line(`Watching env files in ${project.fullName}. ${dim("Ctrl+C to stop.")}`);
  let last = snapshot(root, settings.ignore || [], settings.files);
  let busy = false;

  const timer = setInterval(async () => {
    if (busy) return;
    const current = snapshot(root, settings.ignore || [], settings.files);
    if (current === last) return;
    last = current;
    busy = true;
    try {
      await push({ ...argv, message: argv.message || "Auto push from watch", force: false, dryRun: false });
    } catch (error) {
      printError(error);
    } finally {
      busy = false;
    }
  }, Math.max(1, argv.interval) * 1000);

  await new Promise((resolve) => {
    process.once("SIGINT", () => {
      clearInterval(timer);
      resolve();
    });
  });
  line("Stopped watching.");
};
