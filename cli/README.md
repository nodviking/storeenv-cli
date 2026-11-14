<p align="center">
  <img src="https://storeenv.app/logo.png" alt="StoreEnv" width="140" />
</p>

<h1 align="center">StoreEnv CLI</h1>

<p align="center">
  Git for your <code>.env</code> files. Push, pull, version and share environment secrets with your team.<br />
  Every value is encrypted on your device before it leaves, so the server only ever stores ciphertext.
</p>

<p align="center">
  <a href="https://storeenv.app">Website</a> ·
  <a href="https://storeenv.app/docs">Docs</a> ·
  <a href="https://marketplace.visualstudio.com/items?itemName=realtusharrr.storeenv-vscode">VS Code extension</a>
</p>

---

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [How your files are organised](#how-your-files-are-organised)
- [Everyday commands](#everyday-commands)
- [Local commits (offline)](#local-commits-offline)
- [History and rollback](#history-and-rollback)
- [Sharing with your team](#sharing-with-your-team)
- [Devices and recovery](#devices-and-recovery)
- [Running without .env files](#running-without-env-files)
- [Scripts and CI](#scripts-and-ci)
- [Configuration](#configuration)
- [Security model](#security-model)
- [Troubleshooting](#troubleshooting)

## Install

The command is `storeenv`. Pick whichever suits you.

**macOS and Linux** (a single binary, no Node needed):

```bash
curl -fsSL https://storeenv.app/install.sh | sh
```

**Windows** (PowerShell):

```powershell
irm https://storeenv.app/install.ps1 | iex
```

**Homebrew:**

```bash
brew install tusharrr0302/storeenv/storeenv
```

**npm** (needs Node.js 18 or newer):

```bash
npm i -g storeenv-cli
```

To try it without installing: `npx storeenv-cli login`

The install script verifies a SHA-256 checksum before installing and puts the binary in `~/.storeenv/bin` (on Windows, `%LOCALAPPDATA%\storeenv\bin`). Run it again to update. Set `STOREENV_VERSION=0.1.2` to install a specific version or `STOREENV_INSTALL_DIR` to choose the folder. Binaries cover macOS (Apple Silicon and Intel), Linux (x64 and arm64, glibc) and Windows x64. On Alpine and other musl systems, use npm.

Tab completion for bash or zsh: `storeenv completion >> ~/.bashrc` (or `~/.zshrc`), then open a new terminal.

`storeenv doctor` checks the setup in one go: the API, your session and identity, the key log (verified against its signed head), whether this device can sign what it writes, the project file and your env files.

To uninstall, delete `~/.storeenv/bin/storeenv` (or the binary in the folder you chose), or run `brew uninstall storeenv` or `npm uninstall -g storeenv-cli`. Leave the rest of `~/.storeenv` in place unless you also want to forget this device: it holds your encrypted identity and the teammates' keys you verified. To remove those too, run `storeenv logout --forget-device` first.

## Quick start

```bash
storeenv login          # sign in with GitHub in the browser
cd my-project           # any Git repository
storeenv push           # encrypt and upload every .env file
```

On another machine, or for a teammate:

```bash
storeenv login
cd my-project
storeenv pull           # decrypt and write the files you're allowed to read
```

The first `login` creates your encryption identity and shows a **24-word recovery phrase**. Write it down. It is the only way to recover your keys if you lose all your devices, and StoreEnv can't reset it for you.

## How your files are organised

StoreEnv finds env files in your repository and sorts them by **service** (the folder) and **environment** (the file name):

| File | Service | Environment |
| --- | --- | --- |
| `.env` | `root` | `default` |
| `.env.production` | `root` | `production` |
| `backend/.env` | `backend` | `default` |
| `apps/web/.env.staging` | `apps/web` | `staging` |

- `.env.example` and other template files are never uploaded. StoreEnv generates a template with key names (and no values) for your team.
- `node_modules`, `.git`, `dist` and `.next` are skipped.
- The project is linked to your Git remote, so everyone who clones the repository lands in the same project. Private repositories need the StoreEnv GitHub App installed once; the CLI tells you when.
- `production` is protected by default. Only members with production access can read it.

## Everyday commands

| Command | What it does |
| --- | --- |
| `storeenv push` | Encrypt and upload every changed env file as a new version |
| `storeenv push -m "Rotate Stripe key"` | Same, with a version message |
| `storeenv push --file backend/.env` | Push one file only |
| `storeenv pull` | Download and decrypt the files you can read |
| `storeenv pull --env production` | One environment |
| `storeenv status` | Local changes by key name, newer remote versions, unpushed local commits |
| `storeenv diff` | Key level differences between your files and the remote |
| `storeenv diff --reveal` | Include the values you are allowed to read |
| `storeenv scan` | Check env files for problems and leaked secrets without pushing |
| `storeenv watch` | Push automatically whenever an env file changes |
| `storeenv open` | Open the project in the web dashboard |

A pull never silently overwrites local changes you haven't pushed. It asks you to keep your file, overwrite it (a backup is kept next to it), or look at the differences first. Use `--force` to overwrite without asking.

## Local commits (offline)

Save versions on your machine, with or without internet, and upload them later.

```bash
storeenv commit -m "Turn the new checkout flag on"
storeenv commit -m "Point to the staging database"
storeenv log --local       # list commits that aren't pushed yet
storeenv push              # uploads each commit, in order, as its own version
```

| Command | What it does |
| --- | --- |
| `storeenv commit -m "msg"` | Save a snapshot of every env file locally |
| `storeenv commit --undo` | Drop the last local commit (your files stay as they are) |
| `storeenv restore <id>` | Write an older local commit's files back to disk (backups kept) |
| `storeenv log --local` | List local commits |

Snapshots are encrypted with a key that never leaves the device.

## History and rollback

```bash
storeenv log                       # versions with author, time and changed keys
storeenv log --env production -n 50
storeenv diff 3f2a1b9 8c41d07      # compare two versions
storeenv rollback 3f2a1b9 -m "New key broke checkout"
```

A rollback creates a new version equal to the old one, so history is never rewritten. Run `storeenv pull` afterwards to update your files.

## Sharing with your team

Invite people by GitHub username or email, with exactly the access they need:

```bash
storeenv invite @neha --role editor
storeenv invite @contractor --keys backend/.env.production:STRIPE_KEY,STRIPE_WEBHOOK --expires 7d
storeenv invite sam@example.com --files backend/.env --role viewer
storeenv members                   # who has access, and who is waiting for keys
storeenv grant @neha --prod        # production access (owner only)
storeenv revoke @contractor        # removes access and re-keys what they could read
```

| Role | Can do |
| --- | --- |
| `viewer` | Pull what they are granted |
| `editor` | Pull and push |
| `admin` | Everything, including inviting and revoking |

Access can be the whole project, single files, or single keys, with an optional expiry (`24h`, `7d`, `30d`).

Because values are end to end encrypted, a new member can read secrets only after someone who already has them wraps the keys for that member. This happens automatically the next time any member with access runs a command. You can also do it right away with `storeenv share`. Members can ask for more access with `storeenv request`.

## Devices and recovery

```bash
storeenv device ls                 # your enrolled devices
storeenv device approve 7KQ2-MX    # approve a new device from one you already use
storeenv device rm "old-laptop"    # remove a device
storeenv recover                   # restore your identity with the 24-word phrase
```

When you log in on a new machine, choose between approving it from a device you already use (the codes must match on both screens) or entering your recovery phrase.

## Running without .env files

Inject secrets straight into a process, with nothing written to disk:

```bash
storeenv run -- npm start
storeenv run --env staging -- node server.js
storeenv run --service backend -- python manage.py runserver
```

`run` refuses variables that change how programs start (`NODE_OPTIONS`, `PATH`, `LD_PRELOAD`, `DYLD_*`, `BASH_ENV`, `PYTHONSTARTUP` and similar) unless you allow each one by name: `--allow-env NODE_OPTIONS`. It also refuses values that aren't signed by a writer you trust, with no flag to override that: `--allow-env` only lifts the variable name rule, and `--allow-unsigned` doesn't apply to `run` (see Security model).

## Scripts and CI

Every command accepts `--json` for machine readable output and `--yes` to skip confirmations. With `CI=true` the CLI never prompts.

```bash
storeenv status --json
storeenv push --yes -m "Automated update"
```

Errors carry a stable code (for example `SE_REMOTE_AHEAD`), a hint and a distinct exit code, so scripts can react to them.

## Configuration

| Variable or flag | Purpose |
| --- | --- |
| `--project owner/name` | Use a project other than the current repository |
| `--env <name>` | Choose an environment |
| `STOREENV_API` or `--api` | API address, for a self-hosted StoreEnv |
| `STOREENV_HOME` | Folder for config, identity, caches and local commits (default `~/.storeenv`) |
| `STOREENV_PASSPHRASE` | Protect the private key with a passphrase when there is no OS keychain |
| `--trust-writer @login=SE:XXXX-XXXX-XXXX` | Trust a writer for this command only |
| `--allow-unsigned` | `pull` and `diff`: accept values that aren't signed by a current trusted device (printed every time). `run` and `copy` ignore it |
| `STOREENV_RECOVERY_PHRASE` | Recovery phrase for `recover` and `keys signing-setup` in scripts (read once and removed from the environment; no flag takes it) |
| `NO_COLOR` or `--no-color` | Plain output |
| `--verbose` | Debug details |

`storeenv <command> --help` lists every option of a command.

## Security model

- Each secret gets its own random key. Values are encrypted with AES-256-GCM on your device and bound to their project, environment, file and name, so ciphertext can't be moved or swapped.
- Secret keys are wrapped for each reader with X25519 public key encryption. The server stores ciphertext and wrapped keys and can't decrypt either.
- Your private key lives in the OS keychain when available. It is derived from your 24-word recovery phrase.
- Every value and version is signed by the device that wrote it. Devices are certified in the signed key log by your recovery phrase or by another of your devices; removing a device revokes its signing key and every device it certified.
- Before a value is written to a file, put in a process or shown, the CLI checks its signature, the writer's devices in a complete, fresh copy of the key log, and that you trust the writer: yourself, people you verified (`storeenv verify @login SE:...`), writers you trusted for the project (`storeenv trust writer @login SE:...`) or the `writers` list in `.storeenv.json`.
- Values written before signatures existed are unverified: `pull` warns, `run` refuses them (no flag overrides it), and a writer re-signs them after checking with `storeenv sign`. Set up signing on a device once with `storeenv keys signing-setup`.
- Pulled `.env` files are for dotenv parsers. Never `source` one in a shell.
- Revoking a member re-keys everything they could read.
- Every read, write and access change is recorded in the activity log.

More in the [security overview](https://storeenv.app/security).

## Troubleshooting

```bash
storeenv doctor
```

checks your Node version, network, session, identity and repository, and tells you what to fix.

| Message | Fix |
| --- | --- |
| `You're not signed in` | `storeenv login` |
| `This device can't decrypt yet` | Approve it from another device, or `storeenv recover` |
| `Remote has a newer version` | `storeenv pull` first, or `storeenv push --force` |
| `StoreEnv can't see this repository` | Install the StoreEnv GitHub App on the repository (the CLI prints the link) |
| `You have access but no keys yet` | Wait for a member to run any command, or ask them for `storeenv share` |

Questions or bugs: hello@storeenv.app. Security reports: security@storeenv.app.

## License

storeenv-cli is under the Apache License, Version 2.0, copyright 2026 tusharrr0302 (see `LICENSE`).

It includes third-party packages that keep their own licenses: the npm package lists the bundled ones in `THIRD_PARTY_NOTICES.md`. The standalone binary also contains the Node.js runtime; its release archives carry `LICENSE`, `THIRD_PARTY_NOTICES.md` and `LICENSE-node.txt`, which `install.sh`, `install.ps1` and Homebrew keep next to the binary (`~/.storeenv/share/storeenv/` for the install scripts).

Earlier releases keep the terms they were published under (0.1.0 and 0.1.1: ISC). The StoreEnv name and logo are not licensed by the Apache License.
