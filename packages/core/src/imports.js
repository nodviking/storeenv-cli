// Import resolution shared by the CLI, the browser and the API (V1 §9.1).
// Precedence: local values > later imports > earlier imports. Filters apply
// before merging. Imports never chain: callers pass only direct imports.

// Glob over key names (upper case, digits, _ and *); empty filter = all.
// A pattern with any other character matches nothing.
export const matchesImportFilter = (name, filter = []) =>
  !filter?.length || filter.some((pattern) => /^[A-Z0-9_*]{1,128}$/.test(String(pattern)) && new RegExp(`^${String(pattern).replace(/\*/g, ".*")}$`).test(name));

// own: { KEY: value }. imports: [{ id, source, filter, values: { KEY: value } }]
// in position order. Returns the merged values and where each came from.
export const mergeImports = ({ own = {}, imports = [] } = {}) => {
  const values = {};
  const provenance = {};
  for (const item of imports) {
    for (const [key, value] of Object.entries(item.values || {})) {
      if (!matchesImportFilter(key, item.filter)) continue;
      values[key] = value;
      provenance[key] = { kind: "import", importId: item.id, source: item.source };
    }
  }
  for (const [key, value] of Object.entries(own)) {
    values[key] = value;
    provenance[key] = { kind: "local" };
  }
  return { values, provenance };
};
