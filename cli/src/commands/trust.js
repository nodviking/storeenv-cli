// Writers this device trusts for a project. A valid
// signature only shows who wrote a value; trust decides whose values this
// device uses. The repository can also list writers in .storeenv.json
// ("writers": ["@ana=SE:XXXX-XXXX-XXXX"]), which is how CI trusts them.

import { StoreEnvError, fingerprintOf, sameFingerprint } from "@storeenv/core";
import { api } from "../services/api.js";
import { bold, dim, line, setResult, success, table } from "../services/output.js";
import { input, isInteractive } from "../services/prompt.js";
import { openProject } from "../services/session.js";
import { accountState, approveWriter, approvedWriters, forgetWriter, syncLog } from "../services/signing.js";

export const command = "trust <action> [login] [fingerprint]";
export const describe = "Trust writers for this project: trust writer @login SE:XXXX, trust ls, trust rm @login";
export const builder = (yargs) =>
  yargs
    .positional("action", { choices: ["writer", "ls", "rm"], describe: "writer: trust someone's signed values in this project; ls: list trusted writers; rm: stop trusting one" })
    .positional("login", { type: "string", describe: "@username" })
    .positional("fingerprint", { type: "string", describe: "The fingerprint they read to you (SE:XXXX-XXXX-XXXX)" });

export const handler = async (argv) => {
  const context = await openProject(argv, { identity: true });
  const { project, identity } = context;

  if (argv.action === "ls") {
    const pins = Object.entries(approvedWriters(identity, project.id)).map(([userId, item]) => ({ userId, ...item, source: "this device" }));
    const listed = (context.settings?.writers || []).map((item) => {
      const [login, fingerprint] = String(item).split("=");
      return { login: login.replace(/^@/, ""), fingerprint, source: ".storeenv.json" };
    });
    const all = [{ login: context.user.login, fingerprint: identity.fingerprint, source: "you" }, ...listed, ...pins];
    table(["WRITER", "FINGERPRINT", "TRUSTED BY"], all.map((item) => [`@${item.login}`, item.fingerprint, item.source]));
    setResult({ project: project.fullName, writers: all });
    return;
  }

  if (!argv.login) throw new StoreEnvError("SE_INVALID", "Name the writer, for example: storeenv trust writer @ana SE:XXXX-XXXX-XXXX");
  const login = String(argv.login).replace(/^@/, "").toLowerCase();

  if (argv.action === "rm") {
    forgetWriter(identity, project.id, login);
    success(`This device no longer trusts @${login} as a writer for ${project.fullName}.`);
    setResult({ login, trusted: false });
    return;
  }

  // The writer's key must be their current key in the complete key log, and
  // the fingerprint must come from them through another channel.
  const person = await api.publicKey(login);
  const { leaves } = await syncLog(identity);
  const state = accountState(leaves, person.userId);
  if (!state.publicKey || state.publicKey !== person.publicKey) {
    throw new StoreEnvError("SE_KEY_MISMATCH", `The server's key for @${login} isn't their current key in the signed log.`);
  }
  const actual = fingerprintOf(state.publicKey);
  let given = argv.fingerprint;
  if (!given) {
    if (!isInteractive()) throw new StoreEnvError("SE_KEY_NOT_VERIFIED", `Pass the fingerprint @${login} read to you: storeenv trust writer @${login} SE:XXXX-XXXX-XXXX`);
    line(`Ask @${login} for the fingerprint their own device shows (storeenv whoami).`);
    given = await input("Fingerprint they read to you");
  }
  if (!sameFingerprint(given, actual)) throw new StoreEnvError("SE_FINGERPRINT_MISMATCH", `@${login}'s key is ${actual}. The fingerprint you gave, ${given}, doesn't match. Nothing was trusted.`);
  if (!state.accountKey) line(dim(`@${login} hasn't set up signing yet; their values stay unverified until they do.`));
  approveWriter(identity, project.id, { userId: person.userId, login, fingerprint: actual });
  success(`Trusted @${login} (${bold(actual)}) as a writer for ${project.fullName} on this device.`);
  setResult({ login, fingerprint: actual, trusted: true });
};
