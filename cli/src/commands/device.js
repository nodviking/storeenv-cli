import { timeAgo } from "@storeenv/core";
import { api } from "../services/api.js";
import { ensureAuthenticated } from "../services/auth.js";
import { approveDevice } from "../services/identity.js";
import { dim, line, setResult, success, table } from "../services/output.js";
import { confirm, input } from "../services/prompt.js";
import { requireIdentity } from "../services/identity.js";
import { certifyOther, revokeOther, syncLog, accountState } from "../services/signing.js";

export const command = "device <action> [target]";
export const describe = "Manage enrolled devices: ls, approve <code>, deny <code>, rm <name>";
export const builder = (yargs) =>
  yargs
    .positional("action", { choices: ["ls", "approve", "deny", "rm"], describe: "list devices, approve or deny a new device by its code, or remove one by name" })
    .positional("target", { type: "string", describe: "Approval code or device name" })
    .option("device-key", { type: "string", describe: "The device key shown on the new device (SE:XXXX-XXXX-XXXX)" });

export const handler = async (argv) => {
  ensureAuthenticated();
  if (argv.action === "ls") {
    const { devices, sessions } = await api.devices();
    table(
      ["DEVICE", "TYPE", "KEY", "LOCATION", "LAST SEEN", ""],
      devices.map((device) => [device.name, device.kind, device.enrolled ? device.storage || "yes" : dim("no key"), device.location || "", device.lastSeenAt ? timeAgo(device.lastSeenAt) : "", device.current ? "this device" : device.inactive ? "inactive" : ""]),
    );
    line(dim(`${sessions.total} active ${sessions.total === 1 ? "session" : "sessions"} (${sessions.cli} CLI, ${sessions.browser} browser)`));
    setResult({ devices });
    return;
  }

  const need = () => {
    if (!argv.target) throw Object.assign(new Error(argv.action === "rm" ? "Pass a device name." : "Pass the approval code shown on the new device."), { code: "SE_INVALID", exit: 22 });
    return argv.target;
  };

  if (argv.action === "approve" || argv.action === "deny") {
    const { user } = await api.me();
    const { request, approve, deny } = await approveDevice(need(), { userId: user.id });
    const where = [request.os, request.location].filter(Boolean).join(", ");
    if (argv.action === "deny") {
      await deny();
      success(`Denied "${request.deviceName}". Its session was signed out.`);
      return;
    }
    // Only approve a login you started yourself.
    if (!(await confirm(`Approve "${request.deviceName}"${where ? ` (${where})` : ""} for @${user.login}?`, false))) {
      line("Not approved.");
      return;
    }
    // The device key proves the request's key is the new device's own: the
    // server makes the approval code, so the code alone can't.
    const deviceKey = argv.deviceKey || (await input("Device key shown on the new device"));
    // A device that signs also certifies the new device's signing key.
    const identity = requireIdentity(user);
    const { certified } = await approve(deviceKey, { certify: (signingKey, deviceName) => certifyOther(identity, user, { deviceKey: signingKey, deviceName }) });
    success(certified ? "Approved. It can sign as well." : "Approved. It can decrypt; it signs once set up with storeenv keys signing-setup.");
    setResult({ approved: request.deviceName, certified });
    return;
  }

  const { devices } = await api.devices();
  const device = devices.find((item) => item.name === need() || item.id === argv.target);
  if (!device) throw Object.assign(new Error(`No device named "${argv.target}".`), { code: "SE_NOT_FOUND", exit: 44 });
  if (!(await confirm(`Remove "${device.name}"? It will be signed out and can no longer decrypt.`, false))) return;
  // Its signing key is revoked in the key log first, with every device it
  // certified; then the server signs it out.
  if (device.signingKey) {
    const { user } = await api.me();
    const identity = requireIdentity(user);
    const state = accountState((await syncLog(identity)).leaves, user.id);
    if (state.devices.has(device.signingKey)) await revokeOther(identity, user, device.signingKey);
  }
  await api.removeDevice(device.id);
  success(`Removed "${device.name}". If it was stolen, also rotate sensitive values.`);
};
