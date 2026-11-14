import assert from "node:assert/strict";
import { test } from "node:test";
import * as core from "../src/index.js";

test("parseEnv handles quotes, comments, export and multi line values", () => {
  const text = [
    "# comment",
    "PLAIN=value",
    "export EXPORTED=yes",
    'QUOTED="hello world # not a comment"',
    "SINGLE='keep $this \\n literal'",
    "INLINE=abc # trailing comment",
    'ESCAPED="line1\\nline2"',
    'PEM="-----BEGIN KEY-----',
    "abc",
    '-----END KEY-----"',
    "EMPTY=",
    "not a pair",
    "PLAIN=second",
  ].join("\n");
  const { entries, issues } = core.parseEnv(text);
  const map = core.toMap(entries);
  assert.equal(map.get("PLAIN"), "second");
  assert.equal(map.get("EXPORTED"), "yes");
  assert.equal(map.get("QUOTED"), "hello world # not a comment");
  assert.equal(map.get("SINGLE"), "keep $this \\n literal");
  assert.equal(map.get("INLINE"), "abc");
  assert.equal(map.get("ESCAPED"), "line1\nline2");
  assert.equal(map.get("PEM"), "-----BEGIN KEY-----\nabc\n-----END KEY-----");
  assert.equal(map.get("EMPTY"), "");
  assert.deepEqual(issues.map((issue) => issue.type).sort(), ["duplicate", "malformed"]);
});

test("serializeEnv round trips awkward values", () => {
  const values = ["simple", "", "with space", 'quote"inside', "back\\slash", "multi\nline", "hash # tag", " lead", "tab\there", "a=b&c=d", "$HOME"];
  const entries = values.map((value, i) => ({ key: `K${i}`, value }));
  const parsed = core.parseEnv(core.serializeEnv(entries, { header: "written by test" }));
  assert.equal(parsed.issues.length, 0);
  assert.deepEqual(parsed.entries.map((entry) => entry.value), values);
});

test("classification follows folders and suffixes", () => {
  assert.equal(core.classifyService(".env"), "root");
  assert.equal(core.classifyService("backend/.env.production"), "backend");
  assert.equal(core.classifyService("apps/web/.env"), "apps/web");
  assert.equal(core.classifyEnvironment(".env"), "default");
  assert.equal(core.classifyEnvironment("backend/.env.production"), "production");
  assert.equal(core.classifyEnvironment(".env.prod"), "production");
  assert.equal(core.classifyEnvironment(".env.DEV"), "development");
  assert.equal(core.classifyEnvironment(".env.development.local"), "development-local");
  assert.equal(core.classifyEnvironment(".env.example"), null);
  assert.equal(core.classifyEnvironment(".env.storeenv-backup"), null);
  assert.equal(core.isEnvFileName(".envrc"), false);
  assert.equal(core.defaultFilePath("root", "default"), ".env");
  assert.equal(core.defaultFilePath("apps/web", "staging"), "apps/web/.env.staging");
});

test("normalizeRemote understands ssh and https remotes", () => {
  assert.equal(core.normalizeRemote("git@github.com:Acme/CakeShop.git").remote, "github.com/acme/cakeshop");
  assert.equal(core.normalizeRemote("https://user:token@github.com/acme/cakeshop").remote, "github.com/acme/cakeshop");
  assert.equal(core.normalizeRemote("ssh://git@gitlab.com/group/sub/app.git").remote, "gitlab.com/group/sub/app");
  assert.equal(core.normalizeRemote("https://github.com/acme/cakeshop/").slug, "acme/cakeshop");
  assert.equal(core.normalizeRemote("nonsense"), null);
});

test("a secret encrypts and decrypts, and tampering fails closed", () => {
  const esk = core.generateEsk();
  const aad = core.buildAad({ projectId: "prj_1", environment: "production", service: "backend", name: "STRIPE_SECRET_KEY", rev: 1 });
  const value = "sk_live_51Hx_example_value";
  const sealed = core.encryptSecret({ esk, value, aad });
  assert.equal(sealed.size % 32, 0);
  assert.equal(core.decryptSecret({ esk, ...sealed }), value);

  const again = core.encryptSecret({ esk, value, aad });
  assert.notEqual(again.ciphertext, sealed.ciphertext);

  assert.throws(() => core.decryptSecret({ esk, ...sealed, aad: aad.replace("STRIPE_SECRET_KEY", "OTHER") }), { code: "SE_INTEGRITY" });
  assert.throws(() => core.decryptSecret({ esk: core.generateEsk(), ...sealed }), { code: "SE_INTEGRITY" });
  const flipped = core.fromBase64(sealed.ciphertext);
  flipped[0] ^= 1;
  assert.throws(() => core.decryptSecret({ esk, ...sealed, ciphertext: core.toBase64(flipped) }), { code: "SE_INTEGRITY" });
});

test("values of any length and unicode survive padding", () => {
  const esk = core.generateEsk();
  for (const value of ["", "a", "x".repeat(27), "x".repeat(28), "x".repeat(29), "x".repeat(5000), "pässwörd ✓ 密码"]) {
    const sealed = core.encryptSecret({ esk, value, aad: "a|b|c|d|1" });
    assert.equal(core.decryptSecret({ esk, ...sealed }), value);
    assert.equal(sealed.size, core.paddedSize(value));
  }
});

test("an ESK is wrapped per reader and only that reader can unwrap it", () => {
  const alice = core.generateKeyPair();
  const bob = core.generateKeyPair();
  const esk = core.generateEsk();
  const aad = "prj|default|root|KEY|1";
  const forAlice = core.wrapEsk(esk, alice.publicKey, aad);
  const forBob = core.wrapEsk(esk, core.toBase64(bob.publicKey), aad);
  assert.deepEqual(core.unwrapEsk(forAlice, alice.privateKey, aad), esk);
  assert.deepEqual(core.unwrapEsk(forBob, bob.privateKey, aad), esk);
  assert.throws(() => core.unwrapEsk(forAlice, bob.privateKey, aad), { code: "SE_INTEGRITY" });
  assert.throws(() => core.unwrapEsk(forAlice, alice.privateKey, "prj|default|root|OTHER|1"), { code: "SE_INTEGRITY" });
});

test("the same recovery phrase gives the same identity everywhere", () => {
  const phrase = core.generatePhrase();
  assert.equal(phrase.split(" ").length, 24);
  assert.ok(core.isValidPhrase(phrase));
  const a = core.deriveIdentity(phrase);
  const b = core.deriveIdentity(`  ${phrase.toUpperCase().replace(/ /g, "\n")} `);
  assert.equal(a.fingerprint, b.fingerprint);
  assert.match(a.fingerprint, /^SE:[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
  assert.notEqual(core.deriveIdentity(core.generatePhrase()).fingerprint, a.fingerprint);

  const words = phrase.split(" ");
  words[3] = words[3] === "abandon" ? "ability" : "abandon";
  assert.equal(core.isValidPhrase(words.join(" ")), false);
  assert.throws(() => core.deriveIdentity("one two three"), { code: "SE_INVALID" });
});

test("a private key travels to a new device sealed to its ephemeral key", () => {
  const identity = core.deriveIdentity(core.generatePhrase());
  const device = core.generateKeyPair();
  const code = core.newApprovalCode();
  assert.match(code, /^[2-9A-Z]{4}-[2-9A-Z]{2}$/);
  const sealed = core.sealPrivateKeyForDevice(identity.privateKey, device.publicKey, code);
  assert.deepEqual(core.openPrivateKeyFromDevice(sealed, device.privateKey, code), identity.privateKey);
  assert.throws(() => core.openPrivateKeyFromDevice(sealed, device.privateKey, "AAAA-AA"), { code: "SE_INTEGRITY" });
});

test("grants decide what a member can read and write", () => {
  const prod = { env: "production", service: "backend", key: "DB_HOST", protected: true };
  const dev = { env: "development", service: "backend", key: "DB_HOST", protected: false };
  const owner = { role: "owner" };
  const admin = { role: "admin", prodAccess: false, grants: [{ type: "project" }] };
  const editor = { role: "editor", grants: [{ type: "environment", env: "development" }] };
  const contractor = {
    role: "viewer",
    prodAccess: true,
    grants: [
      { type: "secret", env: "production", service: "backend", key: "DB_HOST" },
      { type: "secret", env: "production", service: "backend", key: "DB_USER", expiresAt: new Date(Date.now() - 1000) },
    ],
  };

  assert.ok(core.canReadSecret(owner, prod));
  assert.equal(core.canReadSecret(admin, prod), false);
  assert.ok(core.canReadSecret(admin, dev));
  assert.ok(core.canWriteSecret(editor, dev));
  assert.equal(core.canReadSecret(editor, prod), false);
  assert.ok(core.canReadSecret(contractor, prod));
  assert.equal(core.canWriteSecret(contractor, prod), false);
  assert.equal(core.canReadSecret(contractor, { ...prod, key: "DB_USER" }), false);
  assert.equal(core.canReadSecret(contractor, { ...prod, key: "JWT_SECRET" }), false);
  assert.ok(core.canSeeFile(contractor, prod));
  assert.equal(core.coversFutureKeys(contractor, prod), false);
  assert.ok(core.coversFutureKeys(editor, dev));

  assert.equal(core.describeGrants(owner), "all");
  assert.equal(core.describeGrants(editor), "development");
  assert.equal(core.describeGrants(contractor), "1 key in production/backend");
  assert.equal(core.describeGrants({ role: "viewer", grants: [] }), "nothing");
});

test("parseScopeArg reads CLI scope strings", () => {
  assert.deepEqual(core.parseScopeArg("*", core), [{ type: "project" }]);
  assert.deepEqual(core.parseScopeArg("development", core), [{ type: "environment", env: "development" }]);
  assert.deepEqual(core.parseScopeArg("backend/.env.production", core), [{ type: "file", env: "production", service: "backend" }]);
  assert.deepEqual(core.parseScopeArg("backend/.env.production:DB_HOST,DB_USER", core), [
    { type: "secret", env: "production", service: "backend", key: "DB_HOST" },
    { type: "secret", env: "production", service: "backend", key: "DB_USER" },
  ]);
});

test("the scanner flags provider keys and bad lines without leaking values", () => {
  const value = "rzp_live_AbCdEf123456";
  const text = ["RAZORPAY_KEY_SECRET=" + value, "PORT=3000", "PORT=4000", "broken line", "apiKey=x", "TOKEN=changeme"].join("\n");
  const findings = core.scan(text, { file: "backend/.env" });
  const types = findings.map((finding) => finding.type);
  assert.ok(types.includes("provider-key"));
  assert.ok(types.includes("duplicate"));
  assert.ok(types.includes("malformed"));
  assert.ok(types.includes("key-style"));
  assert.ok(types.includes("placeholder"));
  assert.ok(core.hasBlockingFindings(findings));
  for (const finding of findings) assert.equal(finding.message.includes(value), false);
  assert.equal(core.detectProvider("AKIAIOSFODNN7EXAMPLE").id, "aws");
  assert.equal(core.detectProvider("mongodb+srv://user:pass@cluster.example.net/db").id, "mongodb");
  assert.equal(core.detectProvider("hello"), null);
});

test("diffs compare entries by id and values by content", () => {
  const base = [{ name: "A", id: "1", rev: 1 }, { name: "B", id: "2", rev: 1 }, { name: "C", id: "3", rev: 1 }];
  const head = [{ name: "A", id: "1", rev: 1 }, { name: "B", id: "9", rev: 2 }, { name: "D", id: "4", rev: 1 }];
  assert.deepEqual(core.diffEntries(base, head).map((c) => `${c.op}:${c.key}`), ["modified:B", "removed:C", "added:D"]);
  assert.equal(core.summarizeChanges(core.diffEntries(base, head)), "+1 ~1 -1");
  const changes = core.diffValues(new Map([["A", "1"], ["B", "2"]]), new Map([["A", "1"], ["B", "3"], ["C", "4"]]));
  assert.deepEqual(changes.map((c) => `${c.op}:${c.key}`), ["modified:B", "added:C"]);
  assert.ok(core.matchGlob("INTERNAL_*", "INTERNAL_FLAG"));
  assert.equal(core.matchGlob("INTERNAL_*", "PUBLIC_FLAG"), false);
});

test("durations, ids and keyed hashes behave", () => {
  assert.equal(core.parseDuration("7d"), 7 * 86_400_000);
  assert.equal(core.parseDuration("never"), null);
  assert.equal(core.parseDuration("soon"), undefined);
  assert.match(core.newVersionId(), /^[0-9a-f]{40}$/);
  assert.equal(core.shortId("9f2c81a0000"), "9f2c81a");
  assert.equal(core.normalizeCode("7kq2mx"), "7KQ2-MX");
  const key = core.randomBytes(32);
  assert.equal(core.keyedHash(key, "value"), core.keyedHash(key, "value"));
  assert.notEqual(core.keyedHash(key, "value"), core.keyedHash(core.randomBytes(32), "value"));
  assert.match(core.buildTemplateText([{ name: "A", required: true, description: "The A" }, { name: "B" }], { project: "acme/cakeshop" }), /# The A \| required\nA=\nB=\n$/);
});
