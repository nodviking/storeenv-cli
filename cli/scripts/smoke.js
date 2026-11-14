// Offline checks of a built CLI (the bundle or a binary), used where the
// StoreEnv API isn't available, such as the public repository's CI and
// release workflow. The full suite (test/) runs against a real API.
//
//   node scripts/smoke.js dist/index.js
//   node scripts/smoke.js bin/storeenv

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.resolve(process.argv[2] || path.join(root, "dist/index.js"));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "storeenv-smoke-"));

// Nothing reaches a network: the API address is a closed local port.
const run = (args, cwd = home) => {
  const [command, rest] = target.endsWith(".js") ? [process.execPath, [target, ...args]] : [target, args];
  return spawnSync(command, rest, { cwd, encoding: "utf8", env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, STOREENV_API: "http://127.0.0.1:9", NO_COLOR: "1" } });
};

const checks = [
  ["--version prints the package version", () => {
    const result = run(["--version"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), pkg.version);
  }],
  ["--help lists the commands", () => {
    const result = run(["--help"]);
    assert.equal(result.status, 0, result.stderr);
    for (const command of ["push", "pull", "run", "sign", "trust", "verify"]) assert.match(result.stdout, new RegExp(`storeenv ${command}\\b`));
  }],
  ["an unknown command fails with the usage exit code", () => {
    assert.equal(run(["no-such-command"]).status, 22);
  }],
  ["completion prints a script and completes command names offline", () => {
    const script = run(["completion"]);
    assert.equal(script.status, 0, script.stderr);
    assert.match(script.stdout, /--get-yargs-completions/);
    const words = run(["--get-yargs-completions", "storeenv", "pu"]);
    assert.equal(words.status, 0, words.stderr);
    const listed = words.stdout.split("\n").map((line) => line.split(":")[0]);
    assert.ok(listed.includes("push") && listed.includes("pull"), words.stdout);
  }],
  ["scan works offline", () => {
    const dir = fs.mkdtempSync(path.join(home, "project-"));
    fs.writeFileSync(path.join(dir, ".env"), "PORT=3000\n");
    assert.equal(run(["scan"], dir).status, 0);
  }],
];

let failed = 0;
for (const [name, check] of checks) {
  try {
    check();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${error.message.split("\n")[0]}`);
  }
}
fs.rmSync(home, { recursive: true, force: true });
console.log(failed ? `${failed} of ${checks.length} smoke checks failed (${target})` : `all ${checks.length} smoke checks passed (${target})`);
process.exitCode = failed ? 1 : 0;
