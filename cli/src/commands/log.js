import { timeAgo } from "@storeenv/core";
import { api } from "../services/api.js";
import { listCommits } from "../services/commits.js";
import { localRoot } from "../services/project.js";
import { changeSummary, dim, line, setResult, table } from "../services/output.js";
import { openProject } from "../services/session.js";

export const command = "log";
export const describe = "Show version history, including local commits that aren't pushed yet";
export const builder = (yargs) =>
  yargs
    .option("number", { alias: "n", type: "number", default: 20, describe: "How many versions to show" })
    .option("author", { type: "string", describe: "Only versions by this member" })
    .option("local", { type: "boolean", default: false, describe: "Only local commits (works offline)" });

// What --json shows for a local commit. The encrypted snapshot stays on disk.
const summary = (commit) => ({ id: commit.id, shortId: commit.id.slice(0, 7), message: commit.message, createdAt: commit.createdAt, changes: commit.changes });

const shorten = (text) => (text.length > 44 ? `${text.slice(0, 43)}.` : text);

const localRows = (commits, env) =>
  commits
    .slice()
    .reverse()
    .map((commit) => ({ ...commit, changes: env ? commit.changes.filter((change) => change.environment === env) : commit.changes }))
    .filter((commit) => commit.changes.length)
    .map((commit) => [commit.id.slice(0, 7), shorten(commit.message), [...new Set(commit.changes.map((change) => change.environment))].join(", "), "local", dim(timeAgo(commit.createdAt)), changeSummary(commit.changes)]);

export const handler = async (argv) => {
  const commits = listCommits(localRoot());
  const pending = localRows(commits, argv.env);

  if (argv.local) {
    if (!pending.length) line("No local commits. Save one with: storeenv commit -m \"message\"");
    else table(["COMMIT", "MESSAGE", "ENV", "", "WHEN", "CHANGES"], pending);
    setResult({ local: commits.map(summary) });
    return;
  }

  const { project } = await openProject(argv);
  const { versions } = await api.versions(project.id, { env: argv.env, author: argv.author, limit: argv.number });

  if (pending.length) {
    line(dim(`Not pushed yet (${pending.length}):`));
    table(["COMMIT", "MESSAGE", "ENV", "", "WHEN", "CHANGES"], pending);
    line();
  }
  if (!versions.length) {
    line(`No versions yet. Run storeenv push in your repository.`);
    setResult({ local: commits.map(summary), versions: [] });
    return;
  }
  table(
    ["VERSION", "MESSAGE", "ENV", "AUTHOR", "WHEN", "CHANGES"],
    versions.map((version) => [
      version.shortId,
      shorten(version.message),
      version.environment,
      `@${version.author}`,
      dim(timeAgo(version.createdAt)),
      version.kind === "push" ? changeSummary(version.changes) : `${dim(version.kind)} ${changeSummary(version.changes)}`,
    ]),
  );
  setResult({ project: project.fullName, local: commits.map(summary), versions: versions.map((version) => ({ id: version.id, shortId: version.shortId, environment: version.environment, message: version.message, author: version.author, kind: version.kind, createdAt: version.createdAt, changes: version.changes })) });
};
