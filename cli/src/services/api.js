// HTTP client for the StoreEnv API (/v1). Refreshes the session once when
// the access token has expired, and maps every failure to a StoreEnv error.

import pkg from "../../package.json" with { type: "json" };
import { StoreEnvError, visibleText } from "@storeenv/core";
import { apiBase, readConfig, updateConfig } from "./config.js";
import { debug } from "./output.js";

// The bundle inlines this at build time, so the version always matches package.json.
export const CLIENT_VERSION = pkg.version;

// Every string from the server is shown as text, never as terminal control:
// control characters, C1 codes and bidi overrides become visible escapes
// (newlines and tabs stay). Valid signed fields never contain them, so a
// field that did fails its signature or name check, as a forgery should.
const parse = async (response) => {
  const text = await response.text();
  try {
    return JSON.parse(text, (key, value) => (typeof value === "string" ? visibleText(value) : value));
  } catch {
    return text;
  }
};

const toError = (response, data) => {
  const body = data?.error || {};
  return new StoreEnvError(body.code || (response.status === 401 ? "SE_AUTH_REQUIRED" : "SE_SERVER"), body.message, {
    hint: body.hint,
    requestId: body.requestId || response.headers.get("x-request-id"),
    details: body.details,
    status: response.status,
  });
};

const send = async (method, path, { body, token, auth = true } = {}) => {
  const headers = { "Content-Type": "application/json", "User-Agent": `storeenv-cli/${CLIENT_VERSION}` };
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  const url = `${apiBase()}/v1${path}`;
  debug(`${method} ${url}`);
  let response;
  // A 503 means the service is briefly unavailable (a database restart, a
  // deploy). Reads wait as long as Retry-After says (10 s at most) and try
  // twice more; writes are never repeated here.
  for (let attempt = 0; ; attempt += 1) {
    try {
      response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    } catch (error) {
      throw new StoreEnvError("SE_NETWORK", `Can't reach StoreEnv at ${apiBase()}.`, { details: { cause: error.message } });
    }
    if (response.status !== 503 || method !== "GET" || attempt >= 2) break;
    const wait = Math.min(10, Math.max(1, Number(response.headers.get("retry-after")) || 2));
    debug(`503, retrying in ${wait}s`);
    await response.arrayBuffer().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, wait * 1000));
  }
  const data = await parse(response);
  if (!response.ok) throw toError(response, data);
  return data;
};

let refreshing = null;

const refresh = async () => {
  const config = readConfig();
  if (!config.refreshToken) throw new StoreEnvError("SE_AUTH_REQUIRED");
  if (!refreshing) {
    refreshing = send("POST", "/auth/refresh", { body: { refreshToken: config.refreshToken }, auth: false })
      .then((result) => {
        updateConfig({ token: result.token, refreshToken: result.refreshToken, expiresAt: Date.now() + result.expiresIn * 1000 });
        return result.token;
      })
      .catch((error) => {
        if (error.code === "SE_NETWORK") throw error;
        throw new StoreEnvError("SE_AUTH_TOKEN_EXPIRED", "Your session has expired.", { hint: "Run: storeenv login" });
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
};

export const request = async (method, path, body, { auth = true } = {}) => {
  if (!auth) return send(method, path, { body, auth: false });
  const config = readConfig();
  if (!config.token) throw new StoreEnvError("SE_AUTH_REQUIRED");
  let token = config.token;
  if (config.expiresAt && config.expiresAt - Date.now() < 30_000 && config.refreshToken) token = await refresh();
  try {
    return await send(method, path, { body, token });
  } catch (error) {
    if (error.code !== "SE_AUTH_TOKEN_EXPIRED") throw error;
    return send(method, path, { body, token: await refresh() });
  }
};

const get = (path, options) => request("GET", path, undefined, options);
const post = (path, body = {}, options) => request("POST", path, body, options);
const put = (path, body = {}) => request("PUT", path, body);
const patch = (path, body = {}) => request("PATCH", path, body);
const del = (path, body = {}) => request("DELETE", path, body);

const query = (params = {}) => {
  const pairs = Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== "");
  return pairs.length ? `?${new URLSearchParams(pairs).toString()}` : "";
};

export const api = {
  // auth
  startLogin: (body) => post("/auth/cli/start", body, { auth: false }),
  exchange: (body) => post("/auth/exchange", body, { auth: false }),
  logout: (everywhere) => post("/auth/logout", { everywhere }),
  health: () => get("/health", { auth: false }),

  // organizations, namespaces and account (V1)
  orgs: () => get("/orgs"),
  createOrg: (body) => post("/orgs", body),
  org: (slug) => get(`/orgs/${encodeURIComponent(slug)}`),
  deleteOrg: (slug) => del(`/orgs/${encodeURIComponent(slug)}`, { confirm: slug }),
  addOrgMember: (slug, body) => post(`/orgs/${encodeURIComponent(slug)}/members`, body),
  setOrgRole: (slug, login, role) => patch(`/orgs/${encodeURIComponent(slug)}/members/${encodeURIComponent(login)}`, { role }),
  removeOrgMember: (slug, login) => del(`/orgs/${encodeURIComponent(slug)}/members/${encodeURIComponent(login)}`),
  transferOrg: (slug, login) => post(`/orgs/${encodeURIComponent(slug)}/transfer`, { login, confirm: slug }),
  namespace: (handle) => get(`/namespaces/${encodeURIComponent(handle)}`),
  namespaceProjects: (handle) => get(`/namespaces/${encodeURIComponent(handle)}/projects`),
  claimNamespace: (handle) => post(`/namespaces/${encodeURIComponent(handle)}/claims`),
  namespaceClaims: (handle) => get(`/namespaces/${encodeURIComponent(handle)}/claims`),
  identities: () => get("/me/identities"),
  changeUsername: (username) => put("/me/username", { username }),
  // identity and devices
  me: () => get("/me"),
  enrollDevice: (body) => post("/me/devices/enroll", body),
  devices: () => get("/me/devices"),
  removeDevice: (id) => del(`/me/devices/${id}`),
  createDeviceRequest: (body) => post("/me/devices/requests", body),
  deviceRequest: (code) => get(`/me/devices/requests/${encodeURIComponent(code)}`),
  deviceRequests: () => get("/me/devices/requests"),
  approveDevice: (code, wrappedPrivateKey, certificate) => post(`/me/devices/requests/${encodeURIComponent(code)}/approve`, { wrappedPrivateKey, ...(certificate ? { certificate } : {}) }),
  signingEvent: (event, payload, extra = {}) => post("/me/signing/events", { event, payload, ...extra }),
  logLeaves: (from, to) => get(`/transparency/leaves?from=${from}&to=${to}`),
  denyDevice: (code) => post(`/me/devices/requests/${encodeURIComponent(code)}/deny`),
  syncDevice: (projectId, state) => post("/me/device/sync", { projectId, state }),
  publicKey: (login) => get(`/users/${encodeURIComponent(login)}/public-key`),
  logHead: () => get("/transparency/head"),
  logConsistency: (from, to) => get(`/transparency/consistency?from=${from}&to=${to}`),
  logKeys: (userIds, size) => post("/transparency/keys", { userIds, size }),
  logHistory: (login) => get(`/transparency/users/${encodeURIComponent(login)}`),

  // projects
  linkProject: (body) => post("/projects", body),
  lookupProject: (params) => get(`/projects/lookup${query(params)}`),
  project: (owner, slug) => get(`/projects/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`),
  projectById: (pid) => get(`/projects/by-id/${encodeURIComponent(pid)}`),
  createProject: (body) => post("/projects", body),
  resolveProjects: (body) => post("/projects/resolve", body),
  updateProject: (pid, body) => patch(`/projects/${pid}`, body),
  links: (pid) => get(`/projects/${pid}/links`),
  verifyLink: (pid, lid) => post(`/projects/${pid}/links/${lid}/verify`),
  imports: (pid, env) => get(`/projects/${pid}/imports${query({ env })}`),
  addImport: (pid, body) => post(`/projects/${pid}/imports`, body),
  updateImport: (pid, iid, body) => patch(`/projects/${pid}/imports/${iid}`, body),
  removeImport: (pid, iid) => del(`/projects/${pid}/imports/${iid}`),
  resolvedImports: (pid, env) => get(`/projects/${pid}/envs/${encodeURIComponent(env)}/imports/resolved`),
  usedBy: (pid) => get(`/projects/${pid}/used-by`),
  addLink: (pid, body) => post(`/projects/${pid}/links`, body),
  removeLink: (pid, lid) => del(`/projects/${pid}/links/${lid}`),
  projects: () => get("/projects"),

  // environments and versions
  environments: (pid) => get(`/projects/${pid}/environments`),
  createEnvironment: (pid, body) => post(`/projects/${pid}/environments`, body),
  updateEnvironment: (pid, env, body) => patch(`/projects/${pid}/environments/${env}`, body),
  deleteEnvironment: (pid, env) => del(`/projects/${pid}/environments/${env}`, { confirm: env }),
  head: (pid, env) => get(`/projects/${pid}/envs/${env}/head`),
  versions: (pid, params) => get(`/projects/${pid}/versions${query(params)}`),
  version: (pid, vid) => get(`/projects/${pid}/versions/${vid}`),
  createVersion: (pid, env, body) => post(`/projects/${pid}/envs/${env}/versions`, body),
  compare: (pid, base, head) => get(`/projects/${pid}/compare${query({ base, head })}`),
  rollbackPreview: (pid, env, to) => get(`/projects/${pid}/envs/${env}/rollback/preview${query({ to })}`),
  rollback: (pid, env, body) => post(`/projects/${pid}/envs/${env}/rollback`, body),
  template: (pid) => get(`/projects/${pid}/template`),

  // access
  members: (pid) => get(`/projects/${pid}/members`),
  readers: (pid) => get(`/projects/${pid}/readers`),
  member: (pid, login) => get(`/projects/${pid}/members/${encodeURIComponent(login)}`),
  setGrants: (pid, login, body) => put(`/projects/${pid}/members/${encodeURIComponent(login)}/grants`, body),
  updateMember: (pid, login, body) => patch(`/projects/${pid}/members/${encodeURIComponent(login)}`, body),
  revokePreview: (pid, login) => get(`/projects/${pid}/members/${encodeURIComponent(login)}/revoke-preview`),
  revokeMember: (pid, login, body) => del(`/projects/${pid}/members/${encodeURIComponent(login)}`, body),
  pendingShares: (pid) => get(`/projects/${pid}/key-shares/pending`),
  uploadShares: (pid, shares) => post(`/projects/${pid}/key-shares`, { shares }),
  rekeyTasks: (pid) => get(`/projects/${pid}/rekey`),
  invite: (pid, body) => post(`/projects/${pid}/invites`, body),
  requestAccess: (pid, body) => post(`/projects/${pid}/access-requests`, body),
  accessRequests: (pid) => get(`/projects/${pid}/access-requests`),
  logEvent: (pid, body) => post(`/projects/${pid}/audit/reveal`, body),

  // public
  publicTemplate: (owner, repo) => get(`/templates/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { auth: false }),
};
