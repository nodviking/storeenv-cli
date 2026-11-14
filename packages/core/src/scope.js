// Grants are the policy layer: what a member may read or write.
// The API enforces them, and clients use the same rules to decide who
// receives a key share when a secret is encrypted.

export const ROLES = ["owner", "admin", "editor", "viewer"];
export const SCOPE_TYPES = ["project", "environment", "file", "secret"];

export const isRole = (role) => ROLES.includes(role);
export const canWrite = (role) => role === "owner" || role === "admin" || role === "editor";
export const canManage = (role) => role === "owner" || role === "admin";
export const isOwner = (role) => role === "owner";

export const normalizeScope = (scope) => {
  const type = scope?.type;
  if (type === "project") return { type };
  if (type === "environment" && scope.env) return { type, env: scope.env };
  if (type === "file" && scope.env && scope.service) return { type, env: scope.env, service: scope.service };
  if (type === "secret" && scope.env && scope.service && scope.key) {
    return { type, env: scope.env, service: scope.service, key: scope.key };
  }
  return null;
};

const expired = (expiresAt, now) => Boolean(expiresAt) && new Date(expiresAt).getTime() <= now;

export const activeGrants = (member, now = Date.now()) => {
  if (!member) return [];
  if (member.role === "owner") return [{ type: "project" }];
  if (member.status && member.status !== "active") return [];
  if (expired(member.expiresAt, now)) return [];
  return (member.grants || []).filter((grant) => !expired(grant.expiresAt, now));
};

const hasProduction = (member) => member.role === "owner" || Boolean(member.prodAccess);

const passesProtection = (member, target) => !target.protected || hasProduction(member);

const covers = (grant, target) => {
  if (grant.type === "project") return true;
  if (grant.env !== target.env) return false;
  if (grant.type === "environment") return true;
  if (grant.service !== target.service) return false;
  if (grant.type === "file") return true;
  return grant.type === "secret" && grant.key === target.key;
};

// target: { env, service, key, protected }
export const canReadSecret = (member, target, now) =>
  passesProtection(member, target) && activeGrants(member, now).some((grant) => covers(grant, target));

export const canWriteSecret = (member, target, now) => canWrite(member?.role) && canReadSecret(member, target, now);

// True when the member's scope includes keys added to the file later.
export const coversFutureKeys = (member, target, now) =>
  passesProtection(member, target) &&
  activeGrants(member, now).some((grant) => grant.type !== "secret" && covers(grant, target));

export const canSeeFile = (member, target, now) =>
  passesProtection(member, target) &&
  activeGrants(member, now).some(
    (grant) =>
      grant.type === "project" ||
      (grant.env === target.env && (grant.type === "environment" || grant.service === target.service)),
  );

export const canSeeEnvironment = (member, target, now) =>
  passesProtection(member, target) &&
  activeGrants(member, now).some((grant) => grant.type === "project" || grant.env === target.env);

export const hasProductionAccess = hasProduction;

// "all", "default, development", "4 keys in production/backend"
export const describeGrants = (member, now) => {
  const grants = activeGrants(member, now);
  if (!grants.length) return "nothing";
  if (grants.some((grant) => grant.type === "project")) return "all";

  const parts = [];
  const envs = [...new Set(grants.filter((g) => g.type === "environment").map((g) => g.env))];
  if (envs.length) parts.push(envs.join(", "));

  const files = grants.filter((g) => g.type === "file" && !envs.includes(g.env));
  for (const file of files) parts.push(`${file.env}/${file.service}`);

  const counts = new Map();
  for (const grant of grants) {
    if (grant.type !== "secret" || envs.includes(grant.env)) continue;
    if (files.some((file) => file.env === grant.env && file.service === grant.service)) continue;
    const label = `${grant.env}/${grant.service}`;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  for (const [label, count] of counts) parts.push(`${count} ${count === 1 ? "key" : "keys"} in ${label}`);

  return parts.join(" + ");
};

export const earliestExpiry = (member, now = Date.now()) => {
  const times = [member?.expiresAt, ...(member?.grants || []).map((grant) => grant.expiresAt)]
    .filter(Boolean)
    .map((value) => new Date(value).getTime())
    .filter((time) => time > now);
  return times.length ? new Date(Math.min(...times)) : null;
};

// Parses CLI scope arguments.
//   "*"                                   -> project
//   "production"                          -> environment
//   "backend/.env.production"             -> file
//   "backend/.env.production:DB_HOST,DB_USER" -> secrets
export const parseScopeArg = (text, classify) => {
  const raw = String(text || "").trim();
  if (!raw || raw === "*" || raw === "all") return [{ type: "project" }];
  const [target, keyList] = raw.split(":");
  if (!target.includes(".env")) {
    return [{ type: "environment", env: target.replace(/^env:/, "") }];
  }
  const env = classify.classifyEnvironment(target);
  const service = classify.classifyService(target);
  if (!env) return [];
  if (!keyList) return [{ type: "file", env, service }];
  return keyList
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean)
    .map((key) => ({ type: "secret", env, service, key }));
};
