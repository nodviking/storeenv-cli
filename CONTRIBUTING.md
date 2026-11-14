# Contributing

**Outside contributions aren't accepted yet.** Pull requests from outside the project can't be merged until a contributor agreement is in place. Bug reports and ideas are welcome at hello@storeenv.app, and security reports at security@storeenv.app (see SECURITY.md).

This repository is exported from StoreEnv's development repository: changes land there first, and each export arrives here as one reviewed commit.

## Checks

```
npm ci
npm test --workspace packages/core
npm run build --workspace cli
node cli/scripts/smoke.js cli/dist/index.js
```

## Rules

- Never weaken encryption, key checks or signature checks to make something pass. Add a test for every bug fixed.
- A change to any encoding in the protocol gets a new version string and new test vectors.
- Test fixtures use obviously fake values.
