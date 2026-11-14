import { logout } from "../services/auth.js";
import { forgetIdentity } from "../services/keyring.js";
import { dim, line, success } from "../services/output.js";

export const command = "logout";
export const describe = "Delete the local session (your identity stays unless --forget-device)";
export const builder = (yargs) =>
  yargs
    .option("forget-device", { type: "boolean", default: false, describe: "Also remove the private key from this device" })
    .option("everywhere", { type: "boolean", default: false, describe: "Sign out every session on every device" });

export const handler = async (argv) => {
  await logout({ everywhere: argv.everywhere });
  success(argv.everywhere ? "Signed out everywhere." : "Signed out of this device.");
  if (argv.forgetDevice) {
    forgetIdentity();
    line("Removed the private key from this device.");
    line(dim("You'll need your recovery phrase or another device to decrypt here again."));
  } else {
    line(dim("Your identity is still on this device. Sign in again with: storeenv login"));
  }
};
