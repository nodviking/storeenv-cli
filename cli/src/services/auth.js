// Browser login for a terminal.
// The CLI can't receive an OAuth redirect, so it listens on 127.0.0.1 at a
// free port. The browser brings back a single use code, which the CLI swaps
// for tokens over a direct call. Tokens never travel through a URL.

import http from "node:http";
import { deviceKeyFingerprint, generateDeviceSigningKey } from "@storeenv/core";
import open from "open";
import { StoreEnvError } from "@storeenv/core";
import { CLIENT_VERSION, api } from "./api.js";
import { deleteConfig, readConfig, updateConfig } from "./config.js";
import { deviceInfo, newDeviceKeys } from "./identity.js";

export const getToken = () => readConfig().token || null;

export const ensureAuthenticated = () => {
  if (!getToken()) throw new StoreEnvError("SE_AUTH_REQUIRED");
};

const page = (title, body) =>
  `<!doctype html><meta charset="utf-8"><title>StoreEnv</title><body style="font-family:system-ui;background:#0B1220;color:#E5E7EB;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2>${title}</h2><p style="color:#9CA3AF">${body}</p></div></body>`;

export const startCallbackServer = () => {
  let settle;
  const result = new Promise((resolve) => {
    settle = resolve;
  });
  let respond = null;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    respond = (location, title, body) => {
      if (location) res.writeHead(302, { Location: location }).end();
      else res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page(title, body));
      server.close();
    };
    settle({ code: url.searchParams.get("code"), state: url.searchParams.get("state"), error: url.searchParams.get("error") });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({
        callbackUrl: `http://127.0.0.1:${server.address().port}/callback`,
        result,
        finish: (...args) => respond?.(...args),
        close: () => server.close(),
      });
    });
  });
};

export const openBrowser = async (url) => {
  try {
    await open(url);
    return true;
  } catch {
    return false;
  }
};

export const login = async ({ browser = true, onUrl, timeoutMs = 5 * 60_000 } = {}) => {
  const callback = await startCallbackServer();
  const keys = newDeviceKeys();
  // This device's signing key (S1). It goes with the request so the device
  // that approves can certify it; it is stored once the identity arrives.
  const signing = generateDeviceSigningKey();
  const shownKey = deviceKeyFingerprint(keys.publicKey, signing.publicKeyBase64);
  const previous = readConfig();
  let timer;
  try {
    const start = await api.startLogin({
      callback: callback.callbackUrl,
      ...deviceInfo(),
      clientVersion: CLIENT_VERSION,
      ephemeralPublicKey: keys.publicKey,
      signingKey: signing.publicKeyBase64,
      deviceId: previous.deviceId,
    });
    const opened = browser ? await openBrowser(start.url) : false;
    // The device key is worked out here, from this device's own key, so an
    // approver can check the server didn't swap it (see core trust.js).
    onUrl?.({ url: start.url, code: start.code, opened, deviceKey: shownKey });

    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new StoreEnvError("SE_AUTH_STATE_EXPIRED", "Timed out waiting for the browser.")), timeoutMs);
    });
    const answer = await Promise.race([callback.result, timeout]);

    if (answer.error || !answer.code || answer.state !== start.state) {
      callback.finish(null, "Login cancelled", "You can close this tab and return to your terminal.");
      throw new StoreEnvError("SE_AUTH_REQUIRED", answer.error === "denied" ? "The login was cancelled in the browser." : "The login could not be completed.", { hint: "Run: storeenv login" });
    }

    let session;
    try {
      session = await api.exchange({ code: answer.code, state: answer.state });
    } catch (error) {
      callback.finish(null, "This login link has expired", "Run storeenv login again in your terminal.");
      throw error;
    }

    updateConfig({
      token: session.token,
      refreshToken: session.refreshToken,
      expiresAt: Date.now() + session.expiresIn * 1000,
      userId: session.user.id,
      login: session.user.login,
      deviceId: session.device.id,
      deviceName: session.device.name,
      webUrl: session.webUrl,
    });

    // Send the browser on: new accounts set up their key, everyone else
    // lands on the confirmation page.
    const next = session.user.hasIdentity
      ? `${session.webUrl}/auth/cli/success?code=${encodeURIComponent(session.approvalCode || "")}`
      : `${session.webUrl}/onboarding?cli=${encodeURIComponent(session.approvalCode || "")}`;
    callback.finish(next);

    return { user: session.user, device: session.device, approvalCode: session.approvalCode, deviceSecret: keys.secretKey, deviceKey: shownKey, signingKey: signing.privateKey, webUrl: session.webUrl };
  } finally {
    clearTimeout(timer);
    callback.close();
  }
};

export const logout = async ({ everywhere = false } = {}) => {
  try {
    if (getToken()) await api.logout(everywhere);
  } catch {
    // The local session is removed even when the server can't be reached.
  }
  // The device record survives a sign out, so the next login reuses it.
  const config = readConfig();
  deleteConfig();
  const keep = {};
  for (const field of ["apiUrl", "webUrl", "deviceId", "deviceName"]) if (config[field]) keep[field] = config[field];
  if (Object.keys(keep).length) updateConfig(keep);
};
