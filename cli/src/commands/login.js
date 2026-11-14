import { StoreEnvError } from "@storeenv/core";
import { api } from "../services/api.js";
import { login } from "../services/auth.js";
import { hasLocalIdentity, loadIdentity, recoverIdentity, waitForApproval, deviceInfo } from "../services/identity.js";
import { setupWithPhrase } from "../services/signing.js";
import { describeStorage } from "../services/keyring.js";
import { bold, command as cmd, dim, line, next, setResult, success, warn } from "../services/output.js";
import { choose, hidden, isInteractive } from "../services/prompt.js";

export const command = "login";
export const describe = "Sign in through the browser and unlock your identity on this device";
export const builder = (yargs) =>
  yargs
    .option("browser", { type: "boolean", default: true, describe: "Open the browser (use --no-browser on SSH sessions)" })
    .option("recovery-phrase", { type: "boolean", default: false, describe: "Enrol this device with your recovery phrase" });

export const handler = async (argv) => {
  const session = await login({
    browser: argv.browser,
    onUrl: ({ url, code, opened, deviceKey }) => {
      line(opened ? `Opening ${url} in your browser` : `Open this URL in a browser:\n\n    ${url}\n`);
      line(`Code ${bold(code)} ${dim("(it must match the one in your browser)")}`);
      line(`Device key ${bold(deviceKey)} ${dim("(type it where you approve this device)")}`);
      line(dim("Waiting for authorization...  (Ctrl+C to cancel)"));
      line();
    },
  });
  const { user } = session;
  success(`Signed in as ${bold(`@${user.login}`)}`);
  setResult({ user: { login: user.login }, device: session.device.name });

  // Already enrolled on this machine with the same identity.
  if (user.hasIdentity && hasLocalIdentity()) {
    try {
      const identity = loadIdentity();
      if (identity.fingerprint === user.fingerprint) {
        await api.enrollDevice({ fingerprint: identity.fingerprint, storage: identity.storageLabel, kind: "cli", name: deviceInfo().deviceName, os: deviceInfo().os });
        success(`Identity unlocked    fingerprint  ${identity.fingerprint}`);
        setResult({ fingerprint: identity.fingerprint, enrolled: true });
        next(`cd into a project and run  ${cmd("storeenv push")}`);
        return;
      }
    } catch (error) {
      if (error.code !== "SE_KEY_LOCKED") throw error;
    }
  }

  if (!user.hasIdentity) {
    line("This is your first device. Creating your StoreEnv identity...");
    line();
    line("Your recovery phrase is shown in the browser. Save it there, then confirm 3 words.");
    const { identity, storage } = await waitForApproval({ code: session.approvalCode, secretKey: session.deviceSecret, signingKey: session.signingKey, userId: session.user.id, timeoutMs: 15 * 60_000 });
    success(`Identity created     fingerprint  ${identity.fingerprint}`);
    success(`Device registered    "${session.device.name}"  ${dim(`(${describeStorage(storage)})`)}`);
    setResult({ fingerprint: identity.fingerprint, enrolled: true });
    next(`cd into a project and run  ${cmd("storeenv push")}`);
    return;
  }

  line("This device is not enrolled. Choose how to unlock your identity:");
  let method = argv.recoveryPhrase ? "p" : "a";
  if (!argv.recoveryPhrase && isInteractive()) {
    method = await choose("", [
      { key: "a", label: "Approve from another device", hint: "run storeenv device approve there" },
      { key: "p", label: "Enter my recovery phrase", hint: "the 24 words" },
    ], "a");
  }

  if (method === "p") {
    const phrase = await hidden("Enter your 24-word recovery phrase (input hidden):");
    const { identity, storage } = await recoverIdentity(phrase, user.fingerprint);
    await setupWithPhrase(identity, user, phrase, { deviceName: session.device?.name });
    success(`Identity restored    fingerprint  ${identity.fingerprint}`);
    success(`Device registered    "${session.device.name}"  ${dim(`(${describeStorage(storage)})`)}`);
    setResult({ fingerprint: identity.fingerprint, enrolled: true });
    next(`cd into a project and run  ${cmd("storeenv pull")}`);
    return;
  }

  line(`Approval code: ${bold(session.approvalCode)}`);
  line(`Device key:    ${bold(session.deviceKey)}`);
  line(dim(`On an enrolled device run  storeenv device approve ${session.approvalCode} --device-key ${session.deviceKey}`));
  line(dim("or keep the browser tab open if this browser is unlocked."));
  try {
    const { identity, storage } = await waitForApproval({ code: session.approvalCode, secretKey: session.deviceSecret, signingKey: session.signingKey, userId: session.user.id });
    success(`Approved.`);
    success(`Device registered    "${session.device.name}"  ${dim(`(${describeStorage(storage)})`)}`);
    setResult({ fingerprint: identity.fingerprint, enrolled: true });
    next(`cd into a project and run  ${cmd("storeenv pull")}`);
  } catch (error) {
    if (error.code !== "SE_DEVICE_NOT_ENROLLED") throw error;
    warn("You're signed in, but this device can't decrypt yet.");
    throw new StoreEnvError("SE_DEVICE_NOT_ENROLLED", error.message, { hint: "Run storeenv recover to use your recovery phrase" });
  }
};
