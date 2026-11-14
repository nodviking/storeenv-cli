import open from "open";
import { normalizeEnvironmentName } from "@storeenv/core";
import { line, setResult } from "../services/output.js";
import { openProject, webUrl } from "../services/session.js";

export const command = "open";
export const describe = "Open the current project in the dashboard";
export const builder = (yargs) => yargs.option("print", { type: "boolean", default: false, describe: "Print the URL and don't open a browser" });

export const handler = async (argv) => {
  const { project } = await openProject(argv);
  const url = `${await webUrl()}${project.path}${argv.env ? `/env/${normalizeEnvironmentName(argv.env)}` : ""}`;
  line(url);
  setResult({ url });
  if (!argv.print && !process.env.CI) await open(url).catch(() => {});
};
