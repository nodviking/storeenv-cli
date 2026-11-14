// Stage 0 of S1: values from the server are checked before they reach a
// process, a file or the terminal. These run against the real dotenv
// package, the parser most tools use to read a pulled file.

import assert from "node:assert/strict";
import { test } from "node:test";
import dotenv from "dotenv";
import * as core from "../src/index.js";

const NASTY = [
  "$(touch /tmp/storeenv-pwned)",
  "`touch /tmp/storeenv-pwned`",
  "${HOME}",
  "$HOME",
  "a'b",
  'a"b',
  "a`b",
  "a'b\"c",
  "a'b`c",
  "a\"b`c",
  "line1\nline2",
  "line1\nKEY2=injected",
  "\nNODE_OPTIONS=--require=/tmp/x.js",
  "trailing backslash\\",
  "back\\slash",
  "literal \\n not a newline",
  "carriage\rreturn",
  "crlf\r\nline",
  "  leading and trailing  ",
  "hash # not a comment",
  "#starts with hash",
  "semi;colon && pipe | redirect > file",
  "tab\there",
  "=starts with equals",
  "unicode é ✓ 😀",
  "-----BEGIN PRIVATE KEY-----\nMIIEvQ\n-----END PRIVATE KEY-----",
  "",
];

test("values with shell metacharacters round trip literally through parseEnv", () => {
  const entries = NASTY.map((value, i) => ({ key: `K${i}`, value }));
  const parsed = core.parseEnv(core.serializeEnv(entries));
  assert.deepEqual(parsed.issues, []);
  assert.deepEqual(parsed.entries.map((entry) => entry.value), NASTY);
});

test("every value that fits a dotenv form round trips literally through the real dotenv parser", () => {
  const exact = NASTY.filter((value) => core.isDotenvExact(value));
  // Only values holding every quote character and a backslash are left out.
  assert.deepEqual(NASTY.filter((value) => !core.isDotenvExact(value)), []);
  const text = core.serializeEnv(exact.map((value, i) => ({ key: `K${i}`, value })));
  const parsed = dotenv.parse(text);
  assert.deepEqual(Object.keys(parsed), exact.map((_, i) => `K${i}`), "no extra keys were injected");
  exact.forEach((value, i) => assert.equal(parsed[`K${i}`], value, `K${i}: ${JSON.stringify(value)} -> ${JSON.stringify(text.split("\n").find((line) => line.startsWith(`K${i}=`)))}`));
});

test("a value that fits no dotenv form is still read back exactly by parseEnv and never adds keys under dotenv", () => {
  const value = "all 'three` \"quotes\\ and\nnewline";
  assert.equal(core.isDotenvExact(value), false);
  const text = core.serializeEnv([{ key: "HARD", value }, { key: "AFTER", value: "x" }]);
  assert.equal(core.toMap(core.parseEnv(text).entries).get("HARD"), value);
  assert.deepEqual(Object.keys(dotenv.parse(text)), ["HARD", "AFTER"]);
});

test("no serialized line is evaluated: writing never runs a command", async () => {
  // The formats are for dotenv parsers only; no shell reads them. This checks the
  // writer itself has no evaluation path: the marker is never created.
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const marker = path.join(os.tmpdir(), `storeenv-pwned-${process.pid}`);
  const value = `$(touch ${marker}) \`touch ${marker}\``;
  dotenv.parse(core.serializeEnv([{ key: "X", value }]));
  core.parseEnv(core.serializeEnv([{ key: "X", value }]));
  assert.equal(fs.existsSync(marker), false);
});

test("serializeEnv refuses a key name that would inject lines", () => {
  for (const key of ["A\nNODE_OPTIONS", "A=B", "A B", "", "1ABC", "A\r", "A#B", "A'B", "A\u0000"]) {
    assert.throws(() => core.serializeEnv([{ key, value: "v" }]), (error) => error.code === "SE_UNSAFE_ENV", JSON.stringify(key));
  }
  assert.doesNotThrow(() => core.serializeEnv([{ key: "dotted.name-ok", value: "v" }]));
});

test("strict names: only what the API accepts", () => {
  for (const name of ["API_KEY", "_X", "a1"]) assert.equal(core.isSafeEnvName(name), true, name);
  for (const name of ["", "1A", "A-B", "A.B", "A\nB", "A=B", "A B", "x".repeat(257), null, 7]) assert.equal(core.isSafeEnvName(name), false, String(name));
  assert.throws(() => core.assertSafeEnvNames(["OK", "BAD\nNAME"]), (error) => error.code === "SE_UNSAFE_ENV" && /BAD\\nNAME/.test(error.message));
});

test("process control variables are recognised in any case and by prefix", () => {
  for (const name of ["NODE_OPTIONS", "node_options", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "PATH", "Path", "BASH_ENV", "GIT_SSH_COMMAND", "PYTHONSTARTUP", "JAVA_TOOL_OPTIONS", "STOREENV_API", "NPM_CONFIG_SCRIPT_SHELL", "ComSpec"]) {
    assert.equal(core.isProcessControlVar(name), true, name);
  }
  for (const name of ["DATABASE_URL", "PORT", "NODE_ENV", "API_KEY", "PATHNAME"]) assert.equal(core.isProcessControlVar(name), false, name);
});

test("an entry is accepted only at the location its AAD names", () => {
  const where = { projectId: "prj_1", environment: "production", service: "api" };
  const entry = { name: "KEY", rev: 3, aad: core.buildAad({ ...where, name: "KEY", rev: 3 }) };
  assert.doesNotThrow(() => core.assertEntryLocation(entry, where));
  for (const moved of [
    { ...where, projectId: "prj_2" },
    { ...where, environment: "staging" },
    { ...where, service: "web" },
  ]) assert.throws(() => core.assertEntryLocation(entry, moved), (error) => error.code === "SE_INTEGRITY");
  assert.throws(() => core.assertEntryLocation({ ...entry, name: "OTHER" }, where), (error) => error.code === "SE_INTEGRITY");
  assert.throws(() => core.assertEntryLocation({ ...entry, rev: 2 }, where), (error) => error.code === "SE_INTEGRITY");
  assert.throws(() => core.assertEntryLocation(entry, { projectId: "prj_1" }), (error) => error.code === "SE_INTEGRITY");
});

test("terminal output shows control characters as escapes", () => {
  assert.equal(core.visibleText("ok\u001b]0;pwned\u0007"), "ok\\u001b]0;pwned\\u0007");
  assert.equal(core.visibleText("tab\tand\nnewline"), "tab\tand\nnewline");
  assert.equal(core.visibleText("rtl‮evil"), "rtl\\u202eevil");
});

test("pull writes only to env files of the repository", () => {
  for (const ok of [".env", ".env.production", "api/.env", "apps/web/.env.local"]) assert.equal(core.isSafeRemotePath(ok), true, ok);
  assert.equal(core.isSafeRemotePath("config/secrets.txt", ["config/secrets.txt"]), true, "mapped in .storeenv.json");
  for (const bad of [".git/hooks/pre-commit", ".git/.env", "node_modules/x/.env", ".npmrc", ".envrc", "package.json", "../.env", "a/../.env", "/etc/.env", "a//.env", "./.env", "C:\\x\\.env", "a\\.env", ".env\nx", "", null, ".storeenv/imports/.env", "x".repeat(600) + "/.env"]) {
    assert.equal(core.isSafeRemotePath(bad), false, JSON.stringify(bad));
  }
  assert.throws(() => core.assertSafeRemotePath(".git/hooks/post-checkout"), (error) => error.code === "SE_UNSAFE_ENV");
});
