import * as core from "@storeenv/core";

// Builds grant scopes from CLI flags:
//   --env development --env staging
//   --keys backend/.env.production:DB_HOST,DB_USER
//   --files backend/.env.production
export const scopesFromFlags = (argv, settings = {}) => {
  const classify = {
    classifyEnvironment: (file) => settings.files?.[file] || settings.environments?.[file] || core.classifyEnvironment(file),
    classifyService: core.classifyService,
  };
  const list = (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]).flatMap((item) => String(item).split(/\s+/)).filter(Boolean);
  const scopes = [];
  for (const env of list(argv.env)) scopes.push({ type: "environment", env: core.normalizeEnvironmentName(env) });
  for (const file of list(argv.files)) scopes.push(...core.parseScopeArg(file.split(":")[0], classify));
  for (const keys of list(argv.keys)) {
    const parsed = core.parseScopeArg(keys, classify);
    if (!parsed.length) throw new core.StoreEnvError("SE_INVALID", `"${keys}" isn't a file with keys. Use backend/.env.production:KEY_A,KEY_B`);
    scopes.push(...parsed);
  }
  return scopes;
};
