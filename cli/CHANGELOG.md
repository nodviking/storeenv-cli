# Changelog

## 0.2.3

- `storeenv login` says "Signed in as @you" for every sign in method, without naming a provider.
- Every argument and flag in `storeenv --help` has a description; the docs' CLI reference is generated from the same definitions.
- `storeenv invite` describes inviting by email or StoreEnv username.

## 0.2.2

First release from the public repository, with build provenance on every archive and npm provenance. Published to npm as a staged version that a maintainer approves with two factor authentication.

- Writer signatures: values are signed by the device that wrote them and checked before use; `run` and `copy` refuse unsigned or untrusted values.
- `storeenv sign`, `trust`, `verify`, `keys signing-setup`; `doctor` checks the key log and this device's signing state.
- `--allow-unsigned` needs a typed confirmation on a terminal, or `STOREENV_ALLOW_UNSIGNED=1`.
- `run` forwards termination signals to the program and reports signal exits as 128 + n.
- The macOS Keychain receives the device key on standard input, never as a process argument.
- Shell completion for bash and zsh: `storeenv completion`.
- Licensed under Apache-2.0 from this version; 0.1.0 and 0.1.1 stay under ISC.

## 0.2.1

Not published. npm refused its trusted publishing (`npm publish`), so the release moved to staged publishing as 0.2.2.

## 0.2.0

Not published. Its release failed before publishing (npm refused the trusted publisher, and the package would have lost its `storeenv` command), so the version was skipped.

## 0.1.1

Earlier release, published under the ISC license.
