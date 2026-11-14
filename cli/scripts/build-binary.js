// Builds a standalone `storeenv` executable for the machine it runs on.
// Node, the CLI and every dependency are packed into one file, so people
// can install StoreEnv without Node or npm. Uses Node's single executable
// application support: https://nodejs.org/api/single-executable-applications.html
//
//   node scripts/build-binary.js            -> bin/storeenv (or bin\storeenv.exe)
//   node scripts/build-binary.js --archive  -> also bin/storeenv-<os>-<arch>.tar.gz/.zip plus .sha256
//
// Release builds run once per platform in .github/workflows/cli-release.yml.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { bundledPackages, nodeLicense, renderNotices } from "./notices.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "bin");
const work = path.join(out, ".work");
const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";
const executable = path.join(out, isWindows ? "storeenv.exe" : "storeenv");
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: "inherit", ...options });

const [major] = process.versions.node.split(".").map(Number);
if (major < 22) throw new Error(`Building the binary needs Node 22 or newer (found ${process.versions.node}).`);

rmSync(out, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

// 1. One CommonJS file with everything inlined. Single executable apps run
//    CommonJS and can only require built in modules. Dependencies that use
//    import.meta.url get the executable's own location instead.
const bundle = path.join(work, "storeenv.cjs");
const bundled = await build({
  entryPoints: [path.join(root, "src/index.js")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: `node${major}`,
  define: { "import.meta.url": "__storeenvMetaUrl" },
  banner: { js: 'const __storeenvMetaUrl = require("node:url").pathToFileURL(__filename).href;' },
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
});

// The binary carries Node itself and every bundled package, so it ships
// with their notices: LICENSE (StoreEnv's license), THIRD_PARTY_NOTICES.md and
// LICENSE-node.txt. A missing notice stops the build.
const node = nodeLicense();
const packages = bundledPackages(bundled.metafile, process.cwd());
copyFileSync(path.join(root, "LICENSE"), path.join(out, "LICENSE"));
writeFileSync(path.join(out, "LICENSE-node.txt"), `${node.text}\n`);
writeFileSync(
  path.join(out, "THIRD_PARTY_NOTICES.md"),
  renderNotices({
    title: "Third-party notices for the storeenv binary",
    intro: `This executable contains Node.js ${process.version} (license in LICENSE-node.txt, which also lists the components Node.js includes) and the following packages, which keep their own licenses. StoreEnv itself is under the ${JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).license} license (LICENSE).`,
    packages,
  }),
);
console.log(`notices for ${packages.length} bundled packages and Node.js ${process.version}`);

// 2. The blob Node injects into its own executable.
const blob = path.join(work, "sea.blob");
const seaConfig = path.join(work, "sea-config.json");
writeFileSync(seaConfig, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }));
run(process.execPath, ["--experimental-sea-config", seaConfig]);

// 3. A copy of this Node binary with the blob injected.
copyFileSync(process.execPath, executable);
if (isMac) {
  // The nodejs.org installer ships a universal binary. Keep this machine's half.
  const archs = execFileSync("lipo", ["-archs", executable], { encoding: "utf8" }).trim().split(/\s+/);
  const want = process.arch === "arm64" ? "arm64" : "x86_64";
  if (archs.length > 1) run("lipo", ["-thin", want, executable, "-output", executable]);
  run("codesign", ["--remove-signature", executable]);
}
const postject = createRequire(import.meta.url).resolve("postject/dist/cli.js");
run(process.execPath, [
  postject, executable, "NODE_SEA_BLOB", blob,
  "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ...(isMac ? ["--macho-segment-name", "NODE_SEA"] : []),
]);
// macOS refuses to run unsigned arm64 code, so sign it ad hoc.
if (isMac) run("codesign", ["--sign", "-", executable]);
rmSync(work, { recursive: true, force: true });

// 4. Smoke test: the binary must start and report the package version.
const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const reported = execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
if (reported !== version) throw new Error(`Binary reported "${reported}", expected "${version}".`);
console.log(`built ${path.relative(root, executable)} (${version})`);

// 5. Release archive and checksum, named the way install.sh expects.
if (process.argv.includes("--archive")) {
  const os = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform];
  const arch = { x64: "x64", arm64: "arm64" }[process.arch];
  if (!os || !arch) throw new Error(`No release target for ${process.platform}/${process.arch}.`);
  const name = `storeenv-${os}-${arch}${isWindows ? ".zip" : ".tar.gz"}`;
  const archive = path.join(out, name);
  const notices = ["LICENSE", "THIRD_PARTY_NOTICES.md", "LICENSE-node.txt"];
  if (isWindows) {
    const paths = [executable, ...notices.map((name) => path.join(out, name))].map((item) => `'${item}'`).join(",");
    run("powershell", ["-NoProfile", "-Command", `Compress-Archive -Path ${paths} -DestinationPath '${archive}'`]);
  } else {
    run("tar", ["-czf", archive, "-C", out, "storeenv", ...notices]);
  }
  const sum = createHash("sha256").update(readFileSync(archive)).digest("hex");
  writeFileSync(`${archive}.sha256`, `${sum}  ${name}\n`);
  console.log(`packed bin/${name}`);
}
