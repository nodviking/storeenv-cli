# StoreEnv client

The `storeenv` command line tool and `@storeenv/core`, the library it is built on. StoreEnv stores, versions and shares `.env` files: values are encrypted on your device before upload, and each value is signed by the device that wrote it, so the client can check who wrote a value before using it.

If you know Git, you know StoreEnv:

| Git | StoreEnv |
| --- | --- |
| Repository | Project (namespace/name, its own id in a committed `.storeenv.json`) |
| Remote | Optional link: GitHub, GitLab, Gitea or any host, or none |
| Folder | Service (`frontend/`, `backend/`, root) |
| Branch | Environment, picked by an optional branch rule |
| Commit | Signed version (author, message, changed keys) |
| Submodule / dependency | Import from a library or another project |
| `push / pull / clone` | `storeenv push / pull / init` |

| Folder | What it is |
| --- | --- |
| `packages/core` | Encryption, key derivation, writer signatures, key log verification, `.env` parsing. Includes the protocol test vectors (`packages/core/test/vectors`) |
| `cli` | The `storeenv` command, published to npm as `storeenv-cli` |

## Install

```
npm i -g storeenv-cli
storeenv login
```

## Build

Node 18.17 or later.

```
npm ci
npm run build --workspace cli          # writes cli/dist/index.js
```

## Test

```
npm test --workspace packages/core     # unit tests and protocol test vectors
node cli/scripts/smoke.js cli/dist/index.js
```

The smoke checks run the built CLI offline. The CLI's integration tests need a StoreEnv API and are not part of this repository.

## Security

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## License

Copyright 2026 nodviking. Licensed under the Apache License, Version 2.0; see [LICENSE](LICENSE). Versions of `storeenv-cli` published before this repository (0.1.0 and 0.1.1) were released under the ISC license.

If StoreEnv saved you time, you can [buy me a chai](https://buymeatea.in/storeenv) ☕.
