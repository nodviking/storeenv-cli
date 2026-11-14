// Bundles the CLI and @storeenv/core into one file for npm, so the
// published package needs no separate core package. chalk, open and
// yargs stay ordinary dependencies (npm installs them with their own
// license files). Packages inlined into the bundle get their notices in
// THIRD_PARTY_NOTICES.md, which ships in the npm package.

import { build } from "esbuild";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundledPackages, renderNotices } from "./notices.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

const result = await build({
  entryPoints: [path.join(root, "src/index.js")],
  outfile: path.join(root, "dist/index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  external: Object.keys(pkg.dependencies),
  legalComments: "none",
  // The source reads only the version from package.json. Inline just that,
  // so the bundle doesn't change with scripts or the repository field (the
  // public export rewrites both) and the private and public builds of one
  // commit stay byte identical.
  plugins: [
    {
      name: "package-version-only",
      setup(esbuild) {
        const own = path.join(root, "package.json");
        esbuild.onLoad({ filter: /package\.json$/ }, (args) => (path.resolve(args.path) === own ? { contents: JSON.stringify({ version: pkg.version }), loader: "json" } : undefined));
      },
    },
  ],
  metafile: true,
  logLevel: "warning",
});
chmodSync(path.join(root, "dist/index.js"), 0o755);

// esbuild records inputs relative to its working directory.
const packages = bundledPackages(result.metafile, process.cwd());
writeFileSync(
  path.join(root, "THIRD_PARTY_NOTICES.md"),
  renderNotices({
    title: "Third-party notices for storeenv-cli (npm package)",
    intro: `dist/index.js includes the following packages. They keep their own licenses, reproduced below. storeenv-cli itself is under the ${pkg.license} license (LICENSE). The dependencies npm installs alongside it (${Object.keys(pkg.dependencies).join(", ")}) ship with their own license files.`,
    packages,
  }),
);
console.log(`built dist/index.js (notices for ${packages.length} bundled packages)`);
