// --allow-unsigned overrides a refusal (values signed by a revoked device,
// or an unsigned head where this device saw signed data before). Those are
// exactly the values a malicious server would send, so the override needs a
// person: a typed "yes" on a terminal, asked once per
// run, or STOREENV_ALLOW_UNSIGNED=1 for automation that has decided to
// accept them. CI alone, a pipe or --yes never count.

import { StoreEnvError } from "@storeenv/core";
import { ask as askLine } from "./prompt.js";

let granted = false;
export const resetConsent = () => {
  granted = false;
};

const onTerminal = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

export const unsignedConsent = async (names, { env = process.env, terminal = onTerminal(), ask = askLine } = {}) => {
  if (granted) return true;
  if (env.STOREENV_ALLOW_UNSIGNED === "1") {
    granted = true;
    return true;
  }
  if (env.CI || !terminal) {
    throw new StoreEnvError("SE_UNSIGNED", `--allow-unsigned would use ${names}, which can't be verified. Nothing was written.`, {
      hint: "Without a terminal to confirm on, set STOREENV_ALLOW_UNSIGNED=1 to accept unverified values deliberately",
    });
  }
  const answer = String(await ask(`  ${names} can't be verified: they could have been forged by the server. Use them anyway? Type yes to continue: `)).trim().toLowerCase();
  if (answer !== "yes") throw new StoreEnvError("SE_UNSIGNED", `You declined to use ${names}. Nothing was written.`, { hint: "A writer you trust can check and re-sign them: storeenv sign" });
  granted = true;
  return true;
};
