// Shared start up for commands: signed in, project resolved, key unlocked.

import { api } from "./api.js";
import { rememberProject } from "./commits.js";
import { ensureAuthenticated } from "./auth.js";
import { requireIdentity } from "./identity.js";
import { dim, line, warn } from "./output.js";
import { resolveContext } from "./project.js";
import { sharePending } from "./sharing.js";

export const openProject = async (argv, { create = false, identity = false } = {}) => {
  ensureAuthenticated();
  const context = await resolveContext(argv, { create });
  if (context.project?.id) rememberProject(context.root, context.project.id);
  if (identity) {
    const { user } = await api.me();
    context.user = user;
    context.identity = requireIdentity(user);
  }
  return context;
};

// Every command by an authorised member quietly completes pending key
// shares, so teammates rarely wait long.
export const autoShare = async (context, { quiet = false } = {}) => {
  if (!context.identity) return null;
  try {
    // In the background: unverified people are skipped, never prompted for.
    const result = await sharePending(context.project.id, context.identity, { mode: "skip", quiet: true });
    if (!quiet) {
      for (const person of result.people) line(dim(`Shared ${person.secrets} ${person.secrets === 1 ? "key" : "keys"} with @${person.login}.`));
    }
    return result;
  } catch (error) {
    if (!quiet) warn(`Could not share pending keys: ${error.message}`);
    return null;
  }
};

export const webUrl = async () => {
  const { readConfig } = await import("./config.js");
  return (process.env.STOREENV_WEB || readConfig().webUrl || "https://storeenv.app").replace(/\/$/, "");
};
