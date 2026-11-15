import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CONFIG_VERSION, environmentForBranch, parseProjectConfig, selectEnvironment, serializeProjectConfig } from "../src/index.js";

const ID = "prj_82844d4b6bd8f18da3d790ba";
// Built at runtime so no live-looking key sits in the source.
const FAKE_LIVE_KEY = ["sk", "live", "51H".padEnd(27, "x") + "XYZ"].join("_");
const code = (fn) => {
  try {
    fn();
  } catch (error) {
    return [error.code, error.message];
  }
  return [null, ""];
};

describe(".storeenv.json parsing", () => {
  test("the approved v2 example parses as is", () => {
    const { config, notices, migrated } = parseProjectConfig(JSON.stringify({
      version: 2, project: ID, name: "acme/payments",
      files: { ".env": "development", ".env.production": "production", ".env.staging": "staging" },
      branches: { main: "production", staging: "staging", develop: "development", "*": "development" },
      imports: [],
    }));
    assert.equal(config.project, ID);
    assert.equal(config.files[".env.production"], "production");
    assert.equal(config.branches["*"], "development");
    assert.deepEqual(notices, []);
    assert.equal(migrated, false);
  });

  test("the example without a version is read as v1 and upgraded", () => {
    const { config, migrated, sourceVersion } = parseProjectConfig({ project: ID, files: { ".env": "development" } });
    assert.equal(sourceVersion, 1);
    assert.equal(migrated, true);
    assert.equal(config.version, CONFIG_VERSION);
  });

  test("a CLI 0.1 file migrates environments to files and keeps localId and ignore", () => {
    const { config, migrated } = parseProjectConfig({ localId: "local_abc123", ignore: ["fixtures/"], environments: { "./deploy/prod.env": "production" } });
    assert.equal(migrated, true);
    assert.deepEqual(config.files, { "deploy/prod.env": "production" });
    assert.equal(config.localId, "local_abc123");
    assert.deepEqual(config.ignore, ["fixtures/"]);
    // Kept so a 0.1 CLI in the same repository maps the file the same way.
    assert.deepEqual(config.environments, { "deploy/prod.env": "production" });
    const written = JSON.parse(serializeProjectConfig(config));
    assert.equal(written.version, 2);
    assert.deepEqual(written.files, { "deploy/prod.env": "production" });
    assert.equal(written.extra, undefined);
  });

  test("files wins over a conflicting old environments entry, with a notice", () => {
    const { config, notices } = parseProjectConfig({ version: 2, files: { ".env.x": "staging" }, environments: { ".env.x": "production" } });
    assert.equal(config.files[".env.x"], "staging");
    assert.match(notices[0], /overrides/);
  });

  test("unknown top-level fields are kept with a notice; a newer version is read-only", () => {
    const parsed = parseProjectConfig({ version: 2, project: ID, team: "payments" });
    assert.match(parsed.notices[0], /team/);
    assert.equal(JSON.parse(serializeProjectConfig(parsed.config)).team, "payments");
    const future = parseProjectConfig({ version: 3, project: ID, somethingNew: true });
    assert.equal(future.readOnly, true);
    assert.match(future.notices[0], /version 3/);
    assert.equal(future.config.project, ID);
  });
});

describe(".storeenv.json validation", () => {
  const cases = [
    ["not JSON", "{ nope", /not valid JSON/],
    ["an array", "[]", /JSON object/],
    ["a bad project id", { project: "prj_123" }, /project id/],
    ["a project name in place of the id", { project: "acme/payments" }, /project id/],
    ["a bad name", { name: "no slash" }, /namespace\/project/],
    ["a bad environment name", { files: { ".env": "Prod Env" } }, /environment name/],
    ["a path outside the folder", { files: { "../.env": "production" } }, /inside this folder/],
    ["an absolute path", { files: { "/etc/.env": "production" } }, /inside this folder/],
    ["a bad branch pattern", { branches: { "rel*ease": "staging" } }, /branch name/],
    ["imports that are not a list", { imports: {} }, /imports must be an array/],
    ["an unknown import field", { imports: [{ from: "acme/shared", onyl: ["X"] }] }, /unknown field onyl/],
    ["a version that is not a number", { version: "2" }, /version/],
    ["a secret in the file", { name: "acme/x", files: { ".env": "default" }, ignore: [FAKE_LIVE_KEY] }, /looks like a secret/],
  ];
  for (const [label, input, pattern] of cases) {
    test(`rejects ${label}`, () => {
      const [errorCode, message] = code(() => parseProjectConfig(typeof input === "string" ? input : JSON.stringify(input)));
      assert.equal(errorCode, "SE_CONFIG_INVALID");
      assert.match(message, pattern);
    });
  }
});

// Production, 2026-11-15: init and link refused "storeenv-test2/launch-check"
// because any value of 24 or more characters with a digit looked like a secret.
describe(".storeenv.json tells names and paths from secrets", () => {
  test("long project names and paths with digits are accepted", () => {
    const { config } = parseProjectConfig(JSON.stringify({
      name: "storeenv-test2/launch-check",
      files: { "apps/billing-service2/.env.production": "production", "services/payments-v2/config/.env.staging": "staging" },
      branches: { "release/2026-11-15/hotfix2": "production" },
      ignore: ["fixtures/generated-2026-11/large-files"],
    }));
    assert.equal(config.name, "storeenv-test2/launch-check");
  });
  for (const [label, value] of [
    ["a live provider key", FAKE_LIVE_KEY],
    // Built here so the source holds no token shaped strings for scanners.
    ["a random token", "Zx9Kq2Lm".repeat(4)],
    ["a token with slashes", ["aB3dEf9GhIjK", "lMnOpQrStUvWxYz0123+Qw=="].join("/")],
    ["a lower case hex token", "3f9a1c7e5b".repeat(4)],
    ["a token split by a slash", ["8f4a6c0e9b".repeat(2), "2b4d6f8a3f".repeat(2)].join("/")],
  ]) {
    test(`still refuses ${label}`, () => {
      const [errorCode, message] = code(() => parseProjectConfig(JSON.stringify({ name: "acme/x", ignore: [value] })));
      assert.equal(errorCode, "SE_CONFIG_INVALID");
      assert.match(message, /looks like a secret/);
    });
  }
});

describe("environment selection", () => {
  const config = { branches: { main: "production", "release/*": "staging", "release/hotfix/*": "production", "*": "development" } };

  test("branches map exactly, then by the longest prefix, then by *", () => {
    assert.equal(environmentForBranch("main", config), "production");
    assert.equal(environmentForBranch("release/1.2", config), "staging");
    assert.equal(environmentForBranch("release/hotfix/7", config), "production");
    assert.equal(environmentForBranch("feature/x", config), "development");
    assert.equal(environmentForBranch("feature/x", { branches: { main: "production" } }), null);
  });

  test("a detached HEAD or no Git never matches a branch rule", () => {
    assert.equal(environmentForBranch("HEAD", config), null);
    assert.equal(environmentForBranch(null, config), null);
    assert.equal(selectEnvironment({ branch: "HEAD", config }), null);
  });

  test("explicit choices always beat branch rules", () => {
    assert.deepEqual(selectEnvironment({ flag: "staging", branch: "main", config }), { env: "staging", source: "--env" });
    assert.deepEqual(selectEnvironment({ envVar: "staging", branch: "main", config }), { env: "staging", source: "STOREENV_ENV" });
    assert.deepEqual(selectEnvironment({ chosen: "development", branch: "main", config }), { env: "development", source: "storeenv env use" });
    assert.deepEqual(selectEnvironment({ branch: "main", config }), { env: "production", source: "branch main" });
  });
});

test(".storeenv.json writers: a list of @login=fingerprint, validated and kept", async () => {
  const { parseProjectConfig, serializeProjectConfig } = await import("../src/index.js");
  const { config } = parseProjectConfig({ version: 2, writers: ["@ana=SE:1A2B-3C4D-5E6F", "bo=se:0000-1111-2222"] });
  assert.deepEqual(config.writers, ["@ana=SE:1A2B-3C4D-5E6F", "bo=se:0000-1111-2222"]);
  assert.match(serializeProjectConfig(config), /"writers"/);
  for (const bad of ["ana", "@ana=SE:XYZ", "@ana=SE:1A2B-3C4D-5E6F\n", 7]) {
    assert.throws(() => parseProjectConfig({ version: 2, writers: [bad] }), (error) => error.code === "SE_CONFIG_INVALID", String(bad));
  }
  assert.throws(() => parseProjectConfig({ version: 2, writers: "@ana=SE:1A2B-3C4D-5E6F" }), (error) => error.code === "SE_CONFIG_INVALID");
});
