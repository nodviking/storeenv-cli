import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesImportFilter, mergeImports } from "../src/index.js";

test("filters match whole key names with *", () => {
  assert.equal(matchesImportFilter("STRIPE_KEY", ["STRIPE_*"]), true);
  assert.equal(matchesImportFilter("MY_STRIPE_KEY", ["STRIPE_*"]), false);
  assert.equal(matchesImportFilter("ANY", []), true);
  assert.equal(matchesImportFilter("DB_URL", ["STRIPE_*", "DB_URL"]), true);
  // Anything outside the allowed pattern alphabet is ignored, never a regex.
  assert.equal(matchesImportFilter("A", [".*"]), false);
});

test("local beats later imports, later imports beat earlier ones, filters first", () => {
  const { values, provenance } = mergeImports({
    own: { SHARED: "local" },
    imports: [
      { id: "imp_1", source: "acme/base", filter: [], values: { SHARED: "base", ONLY_BASE: "b", OVERRIDDEN: "base" } },
      { id: "imp_2", source: "acme/stripe", filter: ["OVERRIDDEN", "STRIPE_*"], values: { OVERRIDDEN: "stripe", STRIPE_KEY: "k", IGNORED: "x" } },
    ],
  });
  assert.deepEqual(values, { SHARED: "local", ONLY_BASE: "b", OVERRIDDEN: "stripe", STRIPE_KEY: "k" });
  assert.deepEqual(provenance.SHARED, { kind: "local" });
  assert.equal(provenance.OVERRIDDEN.importId, "imp_2");
  assert.equal(provenance.ONLY_BASE.source, "acme/base");
  assert.equal("IGNORED" in values, false);
});
