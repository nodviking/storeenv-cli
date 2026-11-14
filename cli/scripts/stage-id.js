// Prints the stage id from `npm stage publish --json` output, or exits 1.
//
//   node scripts/stage-id.js stage.json
//
// The JSON may follow other text on stdout (lifecycle scripts print there),
// so each line that opens an object is tried as the start of the document.

import fs from "node:fs";
import { fileURLToPath } from "node:url";

const ID = /^[A-Za-z0-9_-]{6,128}$/;

const find = (value) => {
  if (!value || typeof value !== "object") return null;
  if (typeof value.stageId === "string") return value.stageId;
  for (const child of Object.values(value)) {
    const found = find(child);
    if (found) return found;
  }
  return null;
};

export const stageIdFrom = (text) => {
  const lines = String(text || "").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trimStart().startsWith("{")) continue;
    try {
      const id = find(JSON.parse(lines.slice(i).join("\n")));
      return id && ID.test(id) ? id : null;
    } catch {
      // Not the start of the document; try the next line.
    }
  }
  return null;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const id = stageIdFrom(fs.readFileSync(process.argv[2], "utf8"));
  if (!id) {
    console.error("npm returned no stage id");
    process.exit(1);
  }
  process.stdout.write(id);
}
