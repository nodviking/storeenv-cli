// Every command and global option the CLI accepts, in one place: index.js
// registers them, and the docs reference (web/scripts/cli-reference.mjs) is
// generated from them, so the two can't drift.

import * as account from "./commands/account.js";
import * as commit from "./commands/commit.js";
import * as namespaces from "./commands/namespaces.js";
import * as orgs from "./commands/orgs.js";
import * as copy from "./commands/copy.js";
import * as device from "./commands/device.js";
import * as diff from "./commands/diff.js";
import * as doctor from "./commands/doctor.js";
import * as env from "./commands/env.js";
import * as grant from "./commands/grant.js";
import * as importCmd from "./commands/import.js";
import * as init from "./commands/init.js";
import * as invite from "./commands/invite.js";
import * as keys from "./commands/keys.js";
import * as link from "./commands/link.js";
import * as project from "./commands/project.js";
import * as projects from "./commands/projects.js";
import * as unlink from "./commands/unlink.js";
import * as verify from "./commands/verify.js";
import * as log from "./commands/log.js";
import * as login from "./commands/login.js";
import * as logout from "./commands/logout.js";
import * as members from "./commands/members.js";
import * as open from "./commands/open.js";
import * as pull from "./commands/pull.js";
import * as push from "./commands/push.js";
import * as recover from "./commands/recover.js";
import * as request from "./commands/request.js";
import * as restore from "./commands/restore.js";
import * as revoke from "./commands/revoke.js";
import * as rollback from "./commands/rollback.js";
import * as run from "./commands/run.js";
import * as scan from "./commands/scan.js";
import * as share from "./commands/share.js";
import * as sign from "./commands/sign.js";
import * as status from "./commands/status.js";
import * as trust from "./commands/trust.js";
import * as watch from "./commands/watch.js";
import * as whoami from "./commands/whoami.js";

export const COMMANDS = [
  login, logout, whoami, account, init, link, unlink, projects, project, orgs, namespaces, commit, push, pull, importCmd, copy, status, diff, log, restore, rollback, env, members, invite, grant, revoke,
  share, sign, trust, keys, verify, request, device, recover, scan, doctor, open, watch, run,
];

export const GLOBAL_OPTIONS = [
  ["project", { type: "string", global: true, describe: "Project as <namespace/name> or its id (default: .storeenv.json, then this repository's remotes)" }],
  ["env", { type: "string", global: true, describe: "Environment name" }],
  ["json", { type: "boolean", global: true, default: false, describe: "Machine readable output" }],
  ["yes", { alias: "y", type: "boolean", global: true, default: false, describe: "Skip confirmations" }],
  ["color", { type: "boolean", global: true, default: true, describe: "Coloured output (--no-color to turn off)" }],
  ["verbose", { type: "boolean", global: true, default: false, describe: "Show debug details" }],
  ["api", { type: "string", global: true, describe: "API base URL of a self-hosted StoreEnv" }],
  ["trust-writer", { type: "string", array: true, global: true, describe: "Trust a writer for this run: @login=SE:XXXX-XXXX-XXXX" }],
  ["allow-unsigned", { type: "boolean", global: true, default: false, describe: "pull and diff: use values that aren't signed by a trusted writer, after you confirm on a terminal (or with STOREENV_ALLOW_UNSIGNED=1). Never applies to run or copy" }],
];

export const COMPLETION = "Print a shell completion script for bash or zsh (add it to ~/.bashrc or ~/.zshrc)";
