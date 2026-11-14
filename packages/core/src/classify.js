// The repository is the configuration:
// Git remote -> project, folder -> service, file suffix -> environment.

export const IGNORED_DIRS = [
  // Pulled imports live here; they must never be pushed as local secrets.
  ".storeenv",
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  "vendor",
  ".venv",
];

const ENV_ALIASES = {
  prod: "production",
  dev: "development",
  stg: "staging",
  stage: "staging",
};

const TEMPLATE_SUFFIXES = new Set(["example", "sample", "template", "dist", "defaults"]);
const SKIPPED_SUFFIXES = new Set(["storeenv-backup", "bak", "backup", "orig", "swp"]);

export const isEnvFileName = (name) => name === ".env" || name.startsWith(".env.");

const suffixOf = (name) => (name === ".env" ? "" : name.slice(5).toLowerCase());

export const isTemplateFileName = (name) => {
  if (!isEnvFileName(name)) return false;
  return suffixOf(name).split(".").some((part) => TEMPLATE_SUFFIXES.has(part));
};

export const isSkippedFileName = (name) => {
  if (!isEnvFileName(name)) return true;
  return suffixOf(name).split(".").some((part) => SKIPPED_SUFFIXES.has(part));
};

export const normalizeEnvironmentName = (name) => {
  const clean = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ENV_ALIASES[clean] || clean;
};

export const isValidEnvironmentName = (name) => /^[a-z0-9][a-z0-9-]{0,39}$/.test(name);

// ".env" -> "default", ".env.production" -> "production", ".env.prod" -> "production".
// Returns null for template files such as .env.example.
export const classifyEnvironment = (fileName) => {
  const name = fileName.split("/").pop();
  if (!isEnvFileName(name) || isTemplateFileName(name) || isSkippedFileName(name)) return null;
  const suffix = suffixOf(name);
  return suffix ? normalizeEnvironmentName(suffix) : "default";
};

// "backend/.env" -> "backend", ".env" -> "root", "apps/web/.env" -> "apps/web".
export const classifyService = (relativePath) => {
  const parts = relativePath.split(/[\\/]/).filter(Boolean);
  parts.pop();
  return parts.length ? parts.join("/") : "root";
};

export const serviceLabel = (service) => service.split("/").pop();

export const serviceDir = (service) => (service === "root" ? "" : service);

export const envFileName = (environment) =>
  environment === "default" ? ".env" : `.env.${environment}`;

export const defaultFilePath = (service, environment) => {
  const dir = serviceDir(service);
  return dir ? `${dir}/${envFileName(environment)}` : envFileName(environment);
};

export const RESERVED_ENVIRONMENTS = new Set(["template"]);
export const PROTECTED_BY_DEFAULT = new Set(["production"]);

// Owner names that collide with application routes.
export const RESERVED_OWNERS = new Set([
  "settings", "orgs", "new", "login", "logout", "auth", "onboarding", "dashboard",
  "projects", "invites", "invitations", "notifications", "activity", "search",
  "device", "unlock", "recover", "api", "t", "p", "product", "security", "pricing",
  "compare", "docs", "changelog", "about", "legal", "blog", "students",
  "403", "404", "500", "maintenance", "session-expired",
  // V1: app routes and names that invite impersonation. Existing holders
  // keep theirs; only new usernames and orgs are refused.
  "admin", "namespaces", "signup", "storeenv", "support", "help", "root", "system", "operator", "staff", "official",
]);
