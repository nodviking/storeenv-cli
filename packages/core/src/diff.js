// Key level diffs. Versions reference immutable entries, so two versions hold
// the same value for a key exactly when they reference the same entry id.

// base, head: arrays of { name, id, rev }
export const diffEntries = (base = [], head = []) => {
  const before = new Map(base.map((entry) => [entry.name, entry]));
  const after = new Map(head.map((entry) => [entry.name, entry]));
  const changes = [];
  for (const [name, entry] of after) {
    const old = before.get(name);
    if (!old) changes.push({ key: name, op: "added", rev: entry.rev });
    else if (old.id !== entry.id) changes.push({ key: name, op: "modified", fromRev: old.rev, rev: entry.rev });
  }
  for (const [name, entry] of before) {
    if (!after.has(name)) changes.push({ key: name, op: "removed", fromRev: entry.rev });
  }
  return changes.sort((a, b) => a.key.localeCompare(b.key));
};

// Plain value maps, used for local comparisons in the CLI and web editor.
export const diffValues = (base = new Map(), head = new Map()) => {
  const changes = [];
  for (const [key, value] of head) {
    if (!base.has(key)) changes.push({ key, op: "added" });
    else if (base.get(key) !== value) changes.push({ key, op: "modified" });
  }
  for (const key of base.keys()) {
    if (!head.has(key)) changes.push({ key, op: "removed" });
  }
  return changes.sort((a, b) => a.key.localeCompare(b.key));
};

export const SYMBOLS = { added: "+", modified: "~", removed: "-", rekeyed: "*" };

export const summarizeChanges = (changes = []) => {
  const count = (op) => changes.filter((change) => change.op === op).length;
  const parts = [];
  if (count("added")) parts.push(`+${count("added")}`);
  if (count("modified")) parts.push(`~${count("modified")}`);
  if (count("removed")) parts.push(`-${count("removed")}`);
  if (count("rekeyed")) parts.push(`${count("rekeyed")} re-keyed`);
  return parts.length ? parts.join(" ") : "no changes";
};

export const matchGlob = (pattern, text) => {
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${source}$`).test(text);
};
