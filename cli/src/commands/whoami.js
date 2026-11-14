import { api } from "../services/api.js";
import { ensureAuthenticated } from "../services/auth.js";
import { hasLocalIdentity, loadIdentity } from "../services/identity.js";
import { dim, line, setResult } from "../services/output.js";
import { resolveContext } from "../services/project.js";

export const command = "whoami";
export const describe = "Show the signed in user, this device and the current project";

export const handler = async (argv) => {
  ensureAuthenticated();
  const { user, device } = await api.me();
  let unlocked = null;
  if (hasLocalIdentity()) {
    try {
      unlocked = loadIdentity();
    } catch {
      unlocked = null;
    }
  }
  let project = null;
  try {
    project = (await resolveContext(argv)).project;
  } catch {
    project = null;
  }

  line(`User         @${user.login}${user.name && user.name !== user.login ? `  ${dim(user.name)}` : ""}`);
  line(`Identity     ${user.fingerprint || dim("not created yet")}`);
  line(`Device       ${device?.name || dim("unknown")}  ${dim(unlocked ? `unlocked via ${unlocked.storageLabel}` : "can't decrypt yet")}`);
  line(`Project      ${project ? project.fullName : dim("none in this directory")}`);
  if (unlocked && user.fingerprint && unlocked.fingerprint !== user.fingerprint) {
    line(dim("This device holds a key for a different identity. Run: storeenv recover"));
  }
  setResult({ login: user.login, fingerprint: user.fingerprint, device: device?.name, enrolled: Boolean(unlocked), project: project?.fullName || null });
};
