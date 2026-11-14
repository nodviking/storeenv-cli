// One place for everything the CLI prints, so output stays consistent:
// "+" added, "~" modified, "-" removed, "!" needs attention.
// Values are never printed by anything in this file.

import chalk from "chalk";
import { shortId } from "@storeenv/core";

const state = { json: false, verbose: false, result: {} };

export const configureOutput = ({ json, color, verbose }) => {
  state.json = Boolean(json);
  state.verbose = Boolean(verbose);
  if (color === false || process.env.NO_COLOR || state.json) chalk.level = 0;
};

export const isJson = () => state.json;
export const isVerbose = () => state.verbose;

const write = (text = "") => {
  if (!state.json) process.stdout.write(`${text}\n`);
};

export const line = (text = "") => write(text ? `  ${text}` : "");
export const blank = () => write("");
export const success = (text) => write(`  ${text}`);
export const info = (text) => write(`  ${chalk.dim(text)}`);
export const warn = (text) => write(`  ${chalk.yellow("!")} ${text}`);
export const next = (text) => write(`\n  ${chalk.dim("Next:")} ${text}`);
export const debug = (text) => {
  if (state.verbose && !state.json) process.stderr.write(chalk.dim(`  [debug] ${text}\n`));
};

export const added = (text) => chalk.green(`+ ${text}`);
export const modified = (text) => chalk.yellow(`~ ${text}`);
export const removed = (text) => chalk.red(`- ${text}`);
export const versionTag = (id) => chalk.dim(`v ${shortId(id)}`);
export const dim = (text) => chalk.dim(text);
export const bold = (text) => chalk.bold(text);
export const command = (text) => chalk.cyan(text);

export const changeSymbol = (op) => ({ added: chalk.green("+"), modified: chalk.yellow("~"), removed: chalk.red("-"), rekeyed: chalk.dim("*") }[op] || " ");

export const changeSummary = (changes) => {
  const count = (op) => changes.filter((change) => change.op === op).length;
  const parts = [];
  if (count("added")) parts.push(chalk.green(`+${count("added")}`));
  if (count("modified")) parts.push(chalk.yellow(`~${count("modified")}`));
  if (count("removed")) parts.push(chalk.red(`-${count("removed")}`));
  if (count("rekeyed")) parts.push(chalk.dim(`${count("rekeyed")} re-keyed`));
  return parts.length ? parts.join(" ") : chalk.dim("no changes");
};

const visibleLength = (text) => String(text).replace(/\u001b\[[0-9;]*m/g, "").length;

export const table = (headers, rows) => {
  if (state.json) return;
  const widths = headers.map((header, i) => Math.max(visibleLength(header), ...rows.map((row) => visibleLength(row[i] ?? ""))));
  const format = (cells, style = (text) => text) =>
    `  ${cells.map((cell, i) => style(String(cell ?? "")) + " ".repeat(Math.max(0, widths[i] - visibleLength(cell ?? "")))).join("   ")}`.trimEnd();
  write(format(headers, chalk.dim));
  for (const row of rows) write(format(row));
};

export const diagnostic = (level, text) => {
  const tag = { ok: chalk.green("[ok]  "), warn: chalk.yellow("[warn]"), fail: chalk.red("[fail]") }[level];
  write(`  ${tag} ${text}`);
};

// A step that shows progress on one line: "Encrypting 19 secrets locally...  done"
export const step = async (label, work) => {
  if (state.json || !process.stdout.isTTY) {
    const result = await work();
    write(`  ${label.padEnd(40)} done`);
    return result;
  }
  process.stdout.write(`  ${label.padEnd(40)} `);
  try {
    const result = await work();
    process.stdout.write(`${chalk.green("done")}\n`);
    return result;
  } catch (error) {
    process.stdout.write(`${chalk.red("failed")}\n`);
    throw error;
  }
};

export const setResult = (data) => {
  Object.assign(state.result, data);
};

export const flushJson = () => {
  if (state.json) process.stdout.write(`${JSON.stringify({ ok: true, ...state.result }, null, 2)}\n`);
};

// Every error has a code, a cause and a fix.
export const printError = (error) => {
  const code = error.code && String(error.code).startsWith("SE_") ? error.code : "SE_SERVER";
  if (state.json) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: { code, message: error.message, hint: error.hint, requestId: error.requestId } }, null, 2)}\n`);
    return;
  }
  process.stderr.write(`\n  ${chalk.red("error")} ${error.message}  ${chalk.dim(code)}\n`);
  if (error.hint) process.stderr.write(`  ${chalk.dim("fix  ")} ${error.hint}\n`);
  if (error.requestId) process.stderr.write(`  ${chalk.dim(`request id ${error.requestId}`)}\n`);
  if (state.verbose && error.stack) process.stderr.write(chalk.dim(`${error.stack}\n`));
  process.stderr.write("\n");
};
