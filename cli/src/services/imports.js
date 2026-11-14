// Imported values for one environment, decrypted on this device with the
// person's own source key shares (V1 §9). Nothing here encrypts.

import { assertSafeEnvNames, formatValue, mergeImports } from "@storeenv/core";
import { api } from "./api.js";
import { warn } from "./output.js";
import { verifyVersion } from "./signing.js";
import { decryptFile } from "./versions.js";
import { writeEnvFile } from "./writer.js";

export const IMPORTS_DIR = ".storeenv/imports";

// verify: the read policy of the command; each source version is checked
// like the project's own before any of its values is used.
export const fetchImports = async (projectId, environment, identity, { quiet = false, verify = null } = {}) => {
  const { imports } = await api.resolvedImports(projectId, environment);
  const out = [];
  for (const item of imports) {
    const name = item.source?.fullName || "a project you can't access";
    if (item.access !== "ok") {
      if (!quiet) warn(item.error === "SE_IMPORT_SOURCE_GONE" ? `Import from ${name} skipped: the source project was deleted.` : `Import from ${name} (${item.sourceEnv}) skipped: you don't have access to it.`);
      continue;
    }
    // The API returns the imported keys only (after the filter), so each
    // entry is checked on its own: writer signature, device chain, trust.
    if (verify && item.version) await verifyVersion(item.version, { projectId: item.source?.id, environment: item.sourceEnv }, { ...verify, entriesOnly: true, pinned: true });
    const values = {};
    let pending = 0;
    for (const file of item.version?.files || []) {
      const decrypted = decryptFile(file, identity, { projectId: item.source?.id, environment: item.sourceEnv });
      pending += decrypted.pending || 0;
      for (const entry of decrypted.entries) values[entry.name] = entry.value;
    }
    if (pending && !quiet) warn(`${pending} imported ${pending === 1 ? "key" : "keys"} from ${name} wait for a key share.`);
    out.push({ id: item.id, source: name, sourceEnv: item.sourceEnv, pin: item.pin, version: item.version?.shortId || null, filter: item.filter, values });
  }
  return out;
};

// own: { KEY: value } of the environment itself.
export const resolveWithImports = (own, imports) => mergeImports({ own, imports });

// Writes imported keys that no local file defines to .storeenv/imports/<env>.env.
// It is never discovered by push (see IGNORED_DIRS), so imported values can't
// turn into copies in this project by accident.
export const writeImportsFile = (root, environment, own, imports) => {
  const { values, provenance } = resolveWithImports({}, imports);
  const lines = [`# Imported into ${environment} by storeenv pull. Read only: changes here are never pushed.`];
  let count = 0;
  assertSafeEnvNames(Object.keys(values));
  for (const [key, value] of Object.entries(values).sort(([a], [b]) => a.localeCompare(b))) {
    if (key in own) continue;
    lines.push(`# from ${String(provenance[key].source).replace(/[\r\n]+/g, " ")}`, `${key}=${formatValue(value)}`);
    count += 1;
  }
  const relative = `${IMPORTS_DIR}/${environment}.env`;
  if (count) writeEnvFile(root, relative, `${lines.join("\n")}\n`);
  return { relative, count };
};
