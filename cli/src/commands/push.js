import { StoreEnvError, normalizeEnvironmentName, shortId } from "@storeenv/core";
import { vetPeople } from "../services/trust.js";
import { api } from "../services/api.js";
import { commitFiles, dropCommits, listCommits } from "../services/commits.js";
import { findEnvFiles } from "../services/filesystem.js";
import { buildManifest, loadCache, saveCache } from "../services/manifest.js";
import { bold, changeSummary, command as cmd, dim, line, setResult, step, table, versionTag, warn } from "../services/output.js";
import { confirm } from "../services/prompt.js";
import { blocking, scan, warnings } from "../services/scanner.js";
import { autoShare, openProject } from "../services/session.js";
import { readPolicy, verifyVersion, writer } from "../services/signing.js";
import { executePush, planPush } from "../services/versions.js";

// The head a push builds on must match its writer's signature, so the files
// it carries forward are authentic (S1).
const checkHeads = async (argv, context, plans) => {
  for (const plan of plans) if (plan.head) await verifyVersion(plan.head, { projectId: context.project.id, environment: plan.environment }, readPolicy(argv, context, "compose"));
};

export const command = "push";
export const describe = "Encrypt and upload env files as a new version";
export const builder = (yargs) =>
  yargs
    .option("message", { alias: "m", type: "string", describe: "Version message, like a commit message" })
    .option("file", { type: "string", describe: "Push one file only, for example backend/.env.production" })
    .option("service", { type: "string", describe: "Push all files of one service" })
    .option("force", { type: "boolean", default: false, describe: "Push on top even if the remote has a newer version" })
    .option("dry-run", { type: "boolean", default: false, describe: "Show the plan and upload nothing" })
    .option("skip-unverified", { type: "boolean", default: false, describe: "Encrypt only for readers whose keys are verified; the rest wait for a key share" });

// Uploads local commits in the order they were made, each as its own
// version with its own message. A commit is removed from this machine as
// soon as it is safely on the server.
const pushLocalCommits = async (context, pending, argv) => {
  const { project, root, settings, identity } = context;
  if (argv.file || argv.service || argv.env) {
    throw new StoreEnvError("SE_INVALID", `You have ${pending.length} local ${pending.length === 1 ? "commit" : "commits"} to push first.`, { hint: "Run storeenv push without --file, --service or --env" });
  }
  line(`Local commits to upload (${pending.length}):`);
  for (const commit of pending) line(`  ${shortId(commit.id)}  ${commit.message}  ${dim(changeSummary(commit.changes))}`);
  line();
  if (argv.dryRun) return [];
  if (!(await confirm(`Upload ${pending.length === 1 ? "this commit" : `these ${pending.length} commits`} as new versions?`, true))) {
    line("Nothing was pushed.");
    return null;
  }

  const listed = await api.readers(project.id);
  const environments = listed.environments;
  const readers = await vetPeople(identity, listed.readers, { mode: argv.skipUnverified ? "skip" : "ask" });
  const cache = loadCache(project.id);
  const uploaded = [];
  for (const commit of pending) {
    const plans = await planPush({ projectId: project.id, files: commitFiles(commit, identity, settings), cache, identity, force: argv.force });
    const changed = plans.filter((plan) => plan.changes > 0);
    await checkHeads(argv, context, changed);
    const stale = changed.find((plan) => plan.stale);
    if (stale) {
      throw new StoreEnvError("SE_REMOTE_AHEAD", `Remote has a newer version on ${stale.environment} (v ${stale.head.shortId} by @${stale.head.author}) than local commit ${shortId(commit.id)}.`, {
        hint: "Run storeenv push --force to add your local commits on top of it",
      });
    }
    const versions = [];
    for (const plan of changed) {
      const isProtected = environments.find((item) => item.name === plan.environment)?.protected ?? plan.environment === "production";
      const result = await executePush({ projectId: project.id, plan, readers, isProtected, message: commit.message, cache, identity, signer: await writer(identity, context.user) });
      versions.push({ environment: plan.environment, id: result.version.id });
    }
    saveCache(project.id, cache);
    dropCommits(root, [commit.id]);
    line(`  ${shortId(commit.id)}  "${commit.message}"  ${versions.map((version) => `${version.environment} ${versionTag(version.id)}`).join("  ") || dim("already on the server")}`);
    uploaded.push({ commit: commit.id, message: commit.message, versions });
  }
  await api.syncDevice(project.id, cache.envs).catch(() => {});
  line();
  return uploaded;
};

export const handler = async (argv) => {
  const context = await openProject(argv, { create: true, identity: true });
  const { project, root, settings, identity } = context;
  const ignore = settings.ignore || [];

  const pending = listCommits(root);
  const uploaded = pending.length ? await pushLocalCommits(context, pending, argv) : [];
  if (uploaded === null) return;
  setResult({ localCommits: uploaded });

  let paths = findEnvFiles(root, { ignore, files: settings.files });
  if (argv.file) {
    const wanted = argv.file.replace(/\\/g, "/").replace(/^\.\//, "");
    paths = paths.filter((item) => item === wanted);
    if (!paths.length) throw new StoreEnvError("SE_NO_ENV_FILES", `${argv.file} was not found.`);
  }
  // With --file, --env maps that file to a custom environment.
  const envOverride = argv.file && argv.env ? normalizeEnvironmentName(argv.env) : undefined;
  const manifest = buildManifest(root, paths, settings, { envOverride });
  let files = manifest.files;
  if (argv.service) files = files.filter((file) => file.service === argv.service);
  if (argv.env && !envOverride) files = files.filter((file) => file.environment === normalizeEnvironmentName(argv.env));
  if (!files.length) throw new StoreEnvError("SE_NO_ENV_FILES");

  const where = [context.remote || (context.inRepo ? "no linked remote" : "no Git"), context.inRepo ? (context.branch ? `branch ${context.branch}` : "detached HEAD") : null].filter(Boolean).join(", ");
  line(`Project    ${bold(project.fullName)}   ${dim(`(${where})`)}`);
  line(`Scanning   ${files.length} env ${files.length === 1 ? "file" : "files"}  ${dim("(ignored: node_modules, .git, dist, .next)")}`);
  line();

  const findings = scan(root, files);
  const errors = blocking(findings);
  if (errors.length) {
    for (const finding of errors) warn(finding.message);
    throw new StoreEnvError("SE_PARSE_ERROR", errors[0].message, { hint: "Fix the line or quote the value, then push again" });
  }

  const cache = loadCache(project.id);
  const plans = await planPush({ projectId: project.id, files, cache, identity, force: argv.force });

  table(
    ["SERVICE", "FILE", "ENV", "CHANGES"],
    plans.flatMap((plan) => plan.files.map((item) => [item.file.service, item.file.path, plan.environment, changeSummary(item.changes)])),
  );
  line();
  for (const plan of plans) {
    for (const item of plan.files) {
      for (const name of item.skipped) warn(`${name} in ${item.file.path} exists remotely but isn't shared with you. It was left as it is.`);
    }
  }
  for (const finding of warnings(findings)) line(`Scanner    ! ${finding.message}`);

  const changed = plans.filter((plan) => plan.changes > 0);
  setResult({ project: project.fullName, plan: plans.map((plan) => ({ environment: plan.environment, files: plan.files.map((item) => ({ path: item.file.path, changes: item.changes })) })) });

  if (!changed.length) {
    for (const plan of plans) if (plan.head) cache.envs[plan.environment] = cache.envs[plan.environment] || plan.head.id;
    line(uploaded.length ? "Your env files match the last commit. Nothing else to push." : "Everything up to date.");
    setResult({ versions: [] });
    await autoShare(context);
    return;
  }

  const stale = changed.find((plan) => plan.stale);
  if (stale) {
    throw new StoreEnvError("SE_REMOTE_AHEAD", `Remote has a newer version on ${stale.environment} (v ${stale.head.shortId} by @${stale.head.author}).`);
  }

  if (argv.dryRun) {
    line(dim("Dry run: nothing was uploaded."));
    return;
  }
  const count = changed.length;
  if (!(await confirm(`Push ${count} ${count === 1 ? "environment" : "environments"} as new ${count === 1 ? "version" : "versions"}?`, true))) {
    line("Nothing was pushed.");
    return;
  }
  line();

  const listed = await api.readers(project.id);
  const environments = listed.environments;
  const readers = await vetPeople(identity, listed.readers, { mode: argv.skipUnverified ? "skip" : "ask" });
  await checkHeads(argv, context, changed);
  const signer = await writer(identity, context.user);
  const secrets = changed.reduce((sum, plan) => sum + plan.encrypt, 0);
  const results = [];
  const waiting = new Set();

  await step(`Encrypting ${secrets} ${secrets === 1 ? "secret" : "secrets"} locally and uploading...`, async () => {
    for (const plan of changed) {
      const isProtected = environments.find((item) => item.name === plan.environment)?.protected ?? plan.environment === "production";
      const result = await executePush({ projectId: project.id, plan, readers, isProtected, message: argv.message, cache, identity, signer });
      results.push({ environment: plan.environment, ...result });
      result.waiting.forEach((login) => waiting.add(login));
    }
  });
  saveCache(project.id, cache);
  await api.syncDevice(project.id, cache.envs).catch(() => {});

  line();
  const width = Math.max(...results.map((result) => result.environment.length));
  for (const result of results) {
    line(`${result.environment.padEnd(width)}  ${versionTag(result.version.id)}   "${result.version.message}"`);
  }
  const members = readers.filter((reader) => reader.publicKey).length;
  line(dim(`Keys wrapped for ${members} ${members === 1 ? "member" : "members"}. Template updated.  View: ${cmd("storeenv open")}`));
  if (waiting.size) warn(`${[...waiting].map((login) => `@${login}`).join(", ")} can't decrypt yet (no key set up). They'll get keys after they finish setup.`);
  await autoShare(context);
  line();
  line(`${dim("Next:")} run ${cmd("storeenv pull")} on another machine`);
  setResult({ versions: results.map((result) => ({ environment: result.environment, id: result.version.id, message: result.version.message })) });
};
