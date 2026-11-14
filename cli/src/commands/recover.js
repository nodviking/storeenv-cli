import { api } from "../services/api.js";
import { ensureAuthenticated } from "../services/auth.js";
import { recoverIdentity } from "../services/identity.js";
import { describeStorage } from "../services/keyring.js";
import { dim, line, setResult, success } from "../services/output.js";
import { hidden } from "../services/prompt.js";
import { setupWithPhrase } from "../services/signing.js";

export const command = "recover";
export const describe = "Restore your identity on this device from the recovery phrase";

export const handler = async () => {
  ensureAuthenticated();
  const { user, device } = await api.me();
  if (!user.hasIdentity) throw Object.assign(new Error("You have no identity yet."), { code: "SE_IDENTITY_MISSING", exit: 11, hint: "Run storeenv login and finish setup in the browser" });
  // From a hidden prompt or standard input; the environment variable is
  // removed at once so no child process inherits it. Never a flag.
  const phrase = process.env.STOREENV_RECOVERY_PHRASE || (await hidden("Enter your 24-word recovery phrase (input hidden):"));
  delete process.env.STOREENV_RECOVERY_PHRASE;
  const { identity, storage } = await recoverIdentity(phrase, user.fingerprint);
  // The phrase also gives the account signing key: it certifies this device.
  const signing = await setupWithPhrase(identity, user, phrase, { deviceName: device?.name });
  const { devices } = await api.devices();
  success(`Identity restored   fingerprint  ${identity.fingerprint}`);
  success(`Device registered   "${device?.name || "this device"}"  ${dim(`(${describeStorage(storage)})`)}`);
  success(`Signing key         ${signing.keyId}  certified by your recovery phrase`);
  line(dim(`Devices on your account: ${devices.length} (review: storeenv device ls)`));
  setResult({ fingerprint: identity.fingerprint, devices: devices.length });
};
