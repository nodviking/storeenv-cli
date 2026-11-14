// One error catalogue shared by the API, the CLI and the web app.
// Each code maps to a CLI exit code, a message and a fix shown to the user.

export const ERRORS = {
  SE_AUTH_REQUIRED: { exit: 10, status: 401, message: "You're not signed in.", hint: "Run: storeenv login" },
  SE_AUTH_STATE_EXPIRED: { exit: 10, status: 400, message: "This login link has expired.", hint: "Run: storeenv login" },
  SE_AUTH_TOKEN_EXPIRED: { exit: 10, status: 401, message: "Your session has expired.", hint: "Run: storeenv login" },
  SE_IDENTITY_MISSING: { exit: 11, status: 409, message: "You have no StoreEnv identity yet.", hint: "Finish setup in the browser: storeenv login" },
  SE_DEVICE_NOT_ENROLLED: { exit: 11, status: 409, message: "This device can't decrypt yet.", hint: "Approve it from another device (storeenv device approve <code>) or run: storeenv recover" },
  SE_KEY_LOCKED: { exit: 11, status: 409, message: "Your private key is locked.", hint: "Unlock your OS keychain or set STOREENV_PASSPHRASE" },
  SE_NOT_A_GIT_REPO: { exit: 20, status: 400, message: "Not inside a Git repository.", hint: "cd into your project or pass --project <owner/name>" },
  SE_NO_REMOTE: { exit: 20, status: 400, message: "This repository has no remote.", hint: "A local project id is kept in .storeenv.json" },
  SE_CONFIG_INVALID: { exit: 22, status: 400, message: ".storeenv.json is invalid.", hint: "Fix the file, or remove it and run storeenv link" },
  SE_PROJECT_NOT_LINKED: { exit: 20, status: 404, message: "This folder isn't linked to a StoreEnv project.", hint: "Run storeenv init to create one, or storeenv link <namespace/name>" },
  SE_NO_ENV_FILES: { exit: 21, status: 400, message: "No .env files found.", hint: "Check ignore rules or create a .env file" },
  SE_PARSE_ERROR: { exit: 21, status: 400, message: "A line isn't KEY=value.", hint: "Fix the line or quote the value" },
  SE_REMOTE_AHEAD: { exit: 30, status: 409, message: "Remote has a newer version.", hint: "Run storeenv pull first, or push --force to add on top" },
  SE_LOCAL_CHANGES: { exit: 30, status: 409, message: "Pull would overwrite unpushed local changes.", hint: "Choose keep, overwrite or diff" },
  SE_GITHUB_APP_REQUIRED: { exit: 42, status: 403, message: "StoreEnv can't see this repository on GitHub.", hint: "If it's private, install the StoreEnv GitHub App on it" },
  SE_REMOTE_PROOF_REQUIRED: { exit: 43, status: 403, message: "Prove you control this repository first.", hint: "Push the verification tag shown, then run storeenv push again" },
  SE_NAMESPACE_TAKEN: { exit: 31, status: 409, message: "That name is taken.", hint: "Pick a different name" },
  SE_PROJECT_AMBIGUOUS: { exit: 31, status: 409, message: "More than one of your projects is linked to this repository.", hint: "Pick one with --project <namespace/name>, or add \"project\" to .storeenv.json" },
  SE_NAMESPACE_FORBIDDEN: { exit: 40, status: 403, message: "You can't create projects in that namespace.", hint: "Use your own namespace or an organization you administer" },
  SE_IMPORT_FORBIDDEN: { exit: 40, status: 403, message: "You can't import from that project.", hint: "You must be a member who can read the source environment" },
  SE_IMPORT_CYCLE: { exit: 31, status: 409, message: "That import would make a cycle.", hint: "Imports are one way; remove the other import first" },
  SE_IMPORT_SOURCE_GONE: { exit: 44, status: 410, message: "The imported project was deleted.", hint: "Remove the import, or restore the source project within 7 days" },
  SE_FORBIDDEN_SCOPE: { exit: 40, status: 403, message: "You can't read or write this.", hint: "Ask for access: storeenv request <file>" },
  SE_PRODUCTION_ACCESS: { exit: 40, status: 403, message: "This environment needs production access.", hint: "Ask an owner to turn on production access for you" },
  SE_KEY_SHARE_PENDING: { exit: 41, status: 409, message: "You have access but no keys yet.", hint: "A member's device will share them soon" },
  SE_INTEGRITY: { exit: 50, status: 422, message: "Integrity check failed.", hint: "Nothing was written. Report this with the request id" },
  SE_FINGERPRINT_MISMATCH: { exit: 50, status: 409, message: "A member's key changed unexpectedly.", hint: "Verify their fingerprint before sharing" },
  SE_KEY_MISMATCH: { exit: 50, status: 409, message: "A public key doesn't match what was verified or logged.", hint: "Nothing was encrypted. Verify the fingerprint with the person: storeenv verify @username" },
  SE_KEY_NOT_VERIFIED: { exit: 51, status: 409, message: "Some readers' keys aren't verified on this device.", hint: "Compare fingerprints and run: storeenv verify @username SE:XXXX-XXXX-XXXX" },
  SE_KEY_ROTATION_REQUIRED: { exit: 52, status: 409, message: "A reader replaced their key.", hint: "Confirm the new fingerprint with them, then: storeenv verify @username SE:XXXX-XXXX-XXXX" },
  SE_KEY_LOG_INCONSISTENT: { exit: 53, status: 409, message: "The server's key log doesn't match what this device saw before.", hint: "Nothing was encrypted. Report this to whoever runs your StoreEnv server" },
  SE_UNSAFE_ENV: { exit: 54, status: 422, message: "A key from the server can't be used safely.", hint: "Nothing was written or run. Check the key name; allow a process variable by name with --allow-env NAME" },
  SE_SIGNATURE: { exit: 55, status: 422, message: "A value's writer signature doesn't verify.", hint: "Nothing was written or run. Report this to whoever runs your StoreEnv server" },
  SE_UNSIGNED: { exit: 56, status: 409, message: "Some values aren't signed by their writer.", hint: "Ask a writer to run storeenv sign, or pass --allow-unsigned once you have checked them" },
  SE_UNKNOWN_WRITER: { exit: 57, status: 409, message: "A value was written by someone this device doesn't trust as a writer.", hint: "Check the writer's fingerprint, then: storeenv trust writer @login SE:XXXX-XXXX-XXXX, or list them in .storeenv.json writers" },
  SE_LOG_STALE: { exit: 58, status: 409, message: "The key log this device has is too old to trust.", hint: "Connect to StoreEnv and retry; revocations newer than one hour may be missing" },
  SE_NETWORK: { exit: 60, status: 503, message: "Can't reach StoreEnv.", hint: "Check your connection or proxy, then run: storeenv doctor" },
  SE_CHALLENGE_REQUIRED: { exit: 60, status: 429, message: "Solve the check and try again.", hint: "The web app solves it for you; retry the sign in" },
  SE_RATE_LIMITED: { exit: 60, status: 429, message: "Too many requests.", hint: "Retry after the time shown" },
  SE_SERVER: { exit: 70, status: 500, message: "Something went wrong on our side.", hint: "Retry, and include the request id if it keeps happening" },
  SE_NOT_FOUND: { exit: 44, status: 404, message: "Not found.", hint: "Check the name, or ask a member for access" },
  SE_INVALID: { exit: 22, status: 400, message: "The request is invalid.", hint: "Check the values you passed" },
  SE_CONFLICT: { exit: 31, status: 409, message: "That already exists.", hint: "Pick a different name" },
  SE_ARCHIVED: { exit: 31, status: 409, message: "This project is archived.", hint: "Pull still works. Unarchive the project to push" },
};

export class StoreEnvError extends Error {
  constructor(code, message, extra = {}) {
    const entry = ERRORS[code] || ERRORS.SE_SERVER;
    super(message || entry.message);
    this.name = "StoreEnvError";
    this.code = ERRORS[code] ? code : "SE_SERVER";
    this.hint = extra.hint || entry.hint;
    this.exit = entry.exit;
    this.status = extra.status || entry.status;
    this.requestId = extra.requestId;
    this.details = extra.details;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        hint: this.hint,
        requestId: this.requestId,
        details: this.details,
      },
    };
  }
}

export const fail = (code, message, extra) => {
  throw new StoreEnvError(code, message, extra);
};
