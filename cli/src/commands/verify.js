import { StoreEnvError, fingerprintOf } from "@storeenv/core";
import { api } from "../services/api.js";
import { ensureAuthenticated } from "../services/auth.js";
import { requireIdentity } from "../services/identity.js";
import { bold, dim, line, setResult, success } from "../services/output.js";
import { input, isInteractive } from "../services/prompt.js";
import { checkLog, knownKeys, pinKey, sameFingerprint } from "../services/trust.js";

// Fetching a key from the server is never verification on its own. A key
// is recorded as verified only when the fingerprint you were given through
// another channel (in person, a call, a signed message) matches the key the
// signed key log holds for that person.
export const command = "verify [login] [fingerprint]";
export const describe = "Verify a teammate's public key by comparing fingerprints, or show the key log head";
export const builder = (yargs) =>
  yargs
    .positional("login", { type: "string", describe: "@username" })
    .positional("fingerprint", { type: "string", describe: "The fingerprint they read to you (SE:XXXX-XXXX-XXXX)" })
    .option("head", { type: "boolean", default: false, describe: "Show the verified key log head, to compare with a teammate" })
    .example("$0 verify @neha SE:1A2B-3C4D-5E6F", "Record @neha's key as verified after she read you her fingerprint")
    .example("$0 verify @neha", "Show @neha's fingerprint and type the one she gives you")
    .example("$0 verify --head", "Print the key log head so two people can compare it");

export const verifyHandler = async (argv) => {
  ensureAuthenticated();
  const { user } = await api.me();
  const identity = requireIdentity(user);

  if (argv.head || !argv.login) {
    const { head } = await checkLog(identity, []);
    line(`Key log     ${bold(head.logKeyId)}`);
    line(`Size        ${head.size} entries`);
    line(`Root        ${head.root}`);
    line(dim("If a teammate's CLI shows a different root at the same size, the server is showing you different logs."));
    setResult({ logKeyId: head.logKeyId, size: head.size, root: head.root });
    return;
  }

  const login = String(argv.login).replace(/^@/, "").toLowerCase();
  const person = await api.publicKey(login);
  if (!person.publicKey) throw new StoreEnvError("SE_NOT_FOUND", `@${person.login} has not set up a key yet.`);
  const { leaves } = await checkLog(identity, [person.userId]);
  const leaf = leaves.get(person.userId);
  const fingerprint = fingerprintOf(person.publicKey);
  if (!leaf || leaf.publicKey !== person.publicKey) {
    throw new StoreEnvError("SE_KEY_MISMATCH", `The server's key for @${person.login} (${fingerprint}) isn't their key in the signed log.`);
  }

  line(`@${person.login}   ${bold(fingerprint)}   ${dim(`key version ${leaf.index}, logged ${leaf.at.slice(0, 10)}`)}`);
  const pin = knownKeys(identity)[person.userId];
  if (pin?.publicKey === person.publicKey && pin.status === "verified") line(dim(`Already verified on ${pin.firstVerifiedAt.slice(0, 10)}.`));

  let given = argv.fingerprint;
  if (!given && isInteractive()) given = await input(`Fingerprint @${person.login} read to you`);
  if (!given) {
    line(dim(`Not recorded. Ask @${person.login} to run "storeenv whoami", then: storeenv verify @${person.login} SE:XXXX-XXXX-XXXX`));
    setResult({ login: person.login, fingerprint, keyVersion: leaf.index, verified: false });
    return;
  }
  if (!sameFingerprint(given, fingerprint)) {
    throw new StoreEnvError("SE_KEY_MISMATCH", `@${person.login}'s key is ${fingerprint}, not ${given}.`, {
      hint: "Don't trust it. Check the fingerprint again with them; if it really differs, someone may be intercepting key shares",
    });
  }
  pinKey(identity, { userId: person.userId, login: person.login, publicKey: person.publicKey, status: "verified", keyVersion: leaf.index });
  success(`Verified @${person.login}  ${dim(fingerprint)}`);
  line(dim(`Pending key shares for @${person.login} complete on your next command, or now with: storeenv share`));
  setResult({ login: person.login, fingerprint, keyVersion: leaf.index, verified: true });
};

export const handler = verifyHandler;
