import { spawn } from "node:child_process";
import os from "node:os";
import { StoreEnvError, assertSafeEnvNames, isProcessControlVar } from "@storeenv/core";
import { api } from "../services/api.js";
import { openProject } from "../services/session.js";
import { singleEnvironment } from "./pull.js";
import { fetchImports, resolveWithImports } from "../services/imports.js";
import { readPolicy, verifyVersion } from "../services/signing.js";
import { decryptFile, fetchHead } from "../services/versions.js";

export const command = "run [cmd..]";
export const describe = "Run a command with secrets injected as environment variables (no files written)";
export const builder = (yargs) =>
  yargs
    .positional("cmd", { type: "string", array: true, describe: "Command to run, after --" })
    .option("service", { type: "string", describe: "Use the secrets of one service (default: all, root first)" })
    .option("imports", { type: "boolean", default: true, describe: "Include imported keys (local keys win; --no-imports to skip)" })
    .option("allow-env", { type: "string", array: true, describe: "Allow a variable that changes how programs start (NODE_OPTIONS, PATH, LD_PRELOAD and others), by name" });

// Names that load code or change which program runs are never injected
// unless allowed one by name: whoever can change the stored values must not
// be able to run code through them.
export const checkInjectable = (values, allowed = []) => {
  assertSafeEnvNames(Object.keys(values));
  const allow = new Set(allowed.flatMap((item) => String(item).split(",")).map((item) => item.trim().toUpperCase()).filter(Boolean));
  const blocked = Object.keys(values).filter((name) => isProcessControlVar(name) && !allow.has(name.toUpperCase()));
  if (blocked.length) {
    throw new StoreEnvError("SE_UNSAFE_ENV", `Refused to start the command: the secrets set ${blocked.join(", ")}, which ${blocked.length === 1 ? "changes" : "change"} how programs start. Nothing was run.`, {
      hint: `If you expected ${blocked.length === 1 ? "it" : "them"}, check who wrote ${blocked.length === 1 ? "it" : "them"} and pass ${blocked.map((name) => `--allow-env ${name}`).join(" ")}`,
      details: { blocked },
    });
  }
};

export const handler = async (argv) => {
  const args = argv.cmd?.length ? argv.cmd : argv["--"] || [];
  if (!args.length) throw new StoreEnvError("SE_INVALID", "Pass a command after --, for example: storeenv run -- npm start");
  const context = await openProject(argv, { identity: true });
  const { project, identity } = context;
  const environment = singleEnvironment(argv, context)?.env || "default";
  const version = await fetchHead(project.id, environment);
  // Names first: a variable that changes how programs start is refused
  // before anything else is read, whatever its signature says.
  const names = (version?.files || []).filter((file) => !argv.service || file.service === argv.service).flatMap((file) => file.entries.filter((entry) => entry.shared && entry.name).map((entry) => entry.name));
  checkInjectable(Object.fromEntries(names.map((name) => [name, ""])), argv.allowEnv || []);
  // run never accepts unverified values: --allow-unsigned doesn't apply here.
  const policy = readPolicy(argv, context, "run");
  const imports = argv.imports === false || argv.service ? [] : await fetchImports(project.id, environment, identity, { verify: policy });
  if (!version && !imports.length) throw new StoreEnvError("SE_NOT_FOUND", `Environment ${environment} has no versions yet.`);
  // Writer signatures, the device chain and writer trust, before any value.
  if (version) await verifyVersion(version, { projectId: project.id, environment }, policy);

  let injected = {};
  const files = (version?.files || [])
    .filter((file) => !argv.service || file.service === argv.service)
    .sort((a, b) => (a.service === "root" ? -1 : b.service === "root" ? 1 : 0));
  for (const file of files) {
    for (const entry of decryptFile(file, identity, { projectId: project.id, environment }).entries) if (!(entry.name in injected)) injected[entry.name] = entry.value;
  }
  // Local values win over imports; later imports over earlier ones.
  if (imports.length) injected = resolveWithImports(injected, imports).values;
  checkInjectable(injected, argv.allowEnv || []);
  const allowed = Object.keys(injected).filter(isProcessControlVar);
  if (allowed.length) process.stderr.write(`storeenv: allowed ${allowed.join(", ")} from stored secrets (--allow-env)\n`);
  await api.logEvent(project.id, { action: "env.pulled", env: environment, count: Object.keys(injected).length }).catch(() => {});

  const child = spawn(args[0], args.slice(1), { stdio: "inherit", env: { ...process.env, ...injected }, shell: process.platform === "win32" });
  // run stays until the program ends. Signals sent to run (docker stop,
  // systemd, kill) go to the program, so it can shut down cleanly instead
  // of being orphaned. Ctrl+C in a terminal already reaches the whole
  // process group, so there SIGINT is not sent a second time.
  const forward = (signal) => () => {
    if (signal === "SIGINT" && process.stdin.isTTY) return;
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  const handlers = ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => [signal, forward(signal)]);
  for (const [signal, handler] of handlers) process.on(signal, handler);
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      // A program ended by a signal: 128 + its number, as shells report it.
      child.on("exit", (status, signal) => resolve(signal ? 128 + (os.constants.signals[signal] || 0) : status ?? 0));
    });
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
};
