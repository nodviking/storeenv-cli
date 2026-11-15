import { StoreEnvError } from "@storeenv/core";
import { api } from "../services/api.js";
import { ensureAuthenticated } from "../services/auth.js";
import { requireIdentity } from "../services/identity.js";
import { bold, line, setResult, success, table } from "../services/output.js";
import { forgetKey, knownKeys } from "../services/trust.js";
import { readConfig } from "../services/config.js";

const readConfigName = () => readConfig().deviceName || null;
import { verifyHandler } from "./verify.js";
import { hidden } from "../services/prompt.js";
import { accountState, deviceKey, setupWithPhrase, syncLog } from "../services/signing.js";

// The public keys this device will encrypt for (~/.storeenv/known_keys).
export const command = "keys [action] [login] [fingerprint]";
export const describe = "List, verify or forget teammates' public keys; set up this device's signing key (signing-setup)";
export const builder = (yargs) =>
  yargs
    .positional("action", { choices: ["list", "trust", "verify", "forget", "signing-setup", "signing"], default: "list", describe: "list teammates' keys, verify (or trust) one by fingerprint, forget one, or set up or show this device's signing key" })
    .positional("login", { type: "string", describe: "@username" })
    .positional("fingerprint", { type: "string", describe: "Their fingerprint, as they read it to you" });

export const handler = async (argv) => {
  if (argv.action === "trust" || argv.action === "verify") return verifyHandler({ ...argv, head: false });
  ensureAuthenticated();
  const { user } = await api.me();
  const identity = requireIdentity(user);

  // Certifies this device with the account signing key, which only the
  // recovery phrase gives. The phrase comes from a hidden prompt or
  // standard input (no flag takes it), and is dropped after.
  if (argv.action === "signing-setup") {
    const phrase = process.env.STOREENV_RECOVERY_PHRASE || (await hidden("Enter your 24-word recovery phrase (input hidden):"));
    delete process.env.STOREENV_RECOVERY_PHRASE;
    const key = await setupWithPhrase(identity, user, phrase, { deviceName: readConfigName() });
    success(`This device signs as ${key.keyId}.`);
    setResult({ signingKey: key.publicKeyBase64, keyId: key.keyId });
    return;
  }

  if (argv.action === "signing") {
    const { leaves } = await syncLog(identity);
    const state = accountState(leaves, user.id);
    const mine = deviceKey();
    line(`Account signing key  ${state.accountKey ? bold(state.accountKey.slice(0, 12)) : "not set up (storeenv keys signing-setup)"}`);
    table(["DEVICE", "SIGNING KEY", "CERTIFIED BY", ""], [...state.devices].map(([key, info]) => [info.deviceName || "", key.slice(0, 12), info.issuer === state.accountKey ? "recovery phrase" : info.issuer.slice(0, 12), key === mine?.publicKeyBase64 ? "this device" : ""]));
    if (state.revoked.size) line(`${state.revoked.size} revoked signing ${state.revoked.size === 1 ? "key" : "keys"}`);
    setResult({ accountKey: state.accountKey, devices: [...state.devices.keys()], revoked: [...state.revoked], thisDevice: mine?.publicKeyBase64 || null, certified: Boolean(mine && state.devices.has(mine.publicKeyBase64)) });
    return;
  }

  if (argv.action === "list") {
    const known = Object.values(knownKeys(identity));
    line(`Your key   ${bold(identity.fingerprint)}`);
    if (!known.length) line("No teammates' keys on this device yet. Verify one with: storeenv verify @username");
    else table(["Member", "Fingerprint", "Status", "Key version", "Last checked"], known.map((item) => [`@${item.login}`, item.fingerprint, item.status, item.keyVersion ?? "-", String(item.lastVerifiedAt).slice(0, 10)]));
    setResult({ fingerprint: identity.fingerprint, keys: known });
    return;
  }

  if (!argv.login) throw new StoreEnvError("SE_INVALID", "Name the member, for example: storeenv keys forget @neha");
  const person = await api.publicKey(String(argv.login).replace(/^@/, ""));
  forgetKey(identity, person.userId);
  success(`Forgot @${person.login}'s key. It must be verified again before anything is encrypted for them.`);
  setResult({ login: person.login, forgotten: true });
};
