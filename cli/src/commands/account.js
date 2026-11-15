import { StoreEnvError } from "@storeenv/core";
import { api } from "../services/api.js";
import { ensureAuthenticated } from "../services/auth.js";
import { line, setResult, success, table } from "../services/output.js";

// The StoreEnv account: username and sign-in methods. Signing in itself is
// storeenv login and storeenv logout; devices are storeenv device.
export const command = "account [action] [value]";
export const describe = "Your account: show, rename <username>, methods";
export const builder = (yargs) =>
  yargs
    .positional("action", { choices: ["show", "rename", "methods"], default: "show", describe: "show your account, rename your username, or list your sign in methods" })
    .positional("value", { type: "string", describe: "New username (rename)" });

export const handler = async (argv) => {
  ensureAuthenticated();
  if (argv.action === "rename") {
    if (!argv.value) throw new StoreEnvError("SE_INVALID", "Pass the new username.");
    const { user } = await api.changeUsername(String(argv.value).replace(/^@/, "").toLowerCase());
    success(`You are now @${user.login}. Links to your old name keep working, and nobody else can take it.`);
    setResult({ login: user.login });
    return;
  }
  if (argv.action === "methods") {
    const { identities } = await api.identities();
    table(["METHOD", "ACCOUNT", "ADDED"], identities.map((item) => [item.provider, item.provider === "github" ? `@${item.username}` : item.email, String(item.createdAt).slice(0, 10)]));
    line("Remove sign-in methods in the web app (Settings, Profile). The last one can't be removed.");
    setResult({ identities: identities.map(({ id, provider, username, email }) => ({ id, provider, username, email })) });
    return;
  }
  const { user } = await api.me();
  line(`@${user.login}${user.name && user.name !== user.login ? `  ${user.name}` : ""}`);
  line(`Email        ${user.email || "none"}`);
  line(`Fingerprint  ${user.fingerprint || "no identity yet"}`);
  setResult({ login: user.login, email: user.email, fingerprint: user.fingerprint || null });
};
