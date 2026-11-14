// Third-party notices for what a bundle actually contains. esbuild's
// metafile lists every input file, so the notices cover exactly the packages
// inlined into the artifact, nothing more or less.
//
// Each package's text comes from its license file, or else from the License
// section of its README (some packages, such as pause or pg-types, have no
// separate file). A package with neither stops the build: an artifact must
// never ship without the notice its license requires.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// Packages whose package.json has no license field, checked by hand. Each
// entry names where the license is stated; the text itself is still read
// from the package, so an override can't invent one.
export const REVIEWED_LICENSES = {
  "pause@0.0.1": { license: "MIT", evidence: "Readme.md, License section: (The MIT License), Copyright (c) 2012 TJ Holowaychuk" },
};

const licenseOf = (pkg) => {
  const reviewed = REVIEWED_LICENSES[`${pkg.name}@${pkg.version}`];
  if (reviewed) return reviewed.license;
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((item) => item.type || item).join(" OR ");
  return null;
};

// node_modules/@scope/name/... or node_modules/name/... -> package directory
const packageDirOf = (file) => {
  const parts = file.split(/[\\/]/);
  const at = parts.lastIndexOf("node_modules");
  if (at < 0) return null;
  const take = parts[at + 1]?.startsWith("@") ? 3 : 2;
  return parts.slice(0, at + take).join("/");
};

// The MIT License text (opensource.org/license/mit), used only for packages
// that declare MIT but don't ship the text themselves.
const MIT = (holder) => `Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

const authorOf = (pkg) => (typeof pkg.author === "string" ? pkg.author : pkg.author?.name) || null;

const licenseText = (dir, pkg = {}, license = null) => {
  const files = readdirSync(dir).filter((name) => /^(licen[cs]e|copying)/i.test(name)).sort();
  if (files.length) return { text: readFileSync(path.join(dir, files[0]), "utf8").trim(), from: files[0] };
  const readme = readdirSync(dir).find((name) => /^readme/i.test(name));
  let statement = "";
  if (readme) {
    const body = readFileSync(path.join(dir, readme), "utf8");
    const match = body.match(/^#{1,3}\s*licen[cs]e\b.*$([\s\S]*?)(?=^#{1,3}\s|\s*$(?![\s\S]))/im);
    if (match && match[1].trim().length > 40) return { text: match[1].trim(), from: `${readme} (License section)` };
    statement = match ? match[1].trim().split("\n")[0] : "";
  }
  // Declared MIT with no text shipped: the standard MIT text, credited to
  // the holder the package names (its README line, else its author field).
  if (license === "MIT") {
    const named = statement.match(/MIT\s*©\s*\[?([^\]\n]+)\]?/)?.[1]?.trim();
    const holder = named || authorOf(pkg);
    if (holder) return { text: MIT(holder), from: `standard MIT text supplied here; the package declares MIT (${statement ? `${readme}: "${statement}"` : "package.json"}) without shipping the text` };
  }
  return null;
};

// Name, version, license and license text for one installed package
// directory, or null for nested marker package.json files.
export const packageNotice = (dir) => {
  const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  if (!pkg.name) return null;
  const key = `${pkg.name}@${pkg.version}`;
  const license = licenseOf(pkg);
  const found = licenseText(dir, pkg, license);
  if (!license || !found) throw new Error(`No license ${!license ? "field" : "text"} for ${key} (${dir}). Add it to the notices by hand after checking its terms.`);
  return { name: pkg.name, version: pkg.version, license, ...found };
};

export const collectNotices = (dirs) => {
  const seen = new Map();
  for (const dir of [...dirs].sort()) {
    const item = packageNotice(dir);
    if (item && !seen.has(`${item.name}@${item.version}`)) seen.set(`${item.name}@${item.version}`, item);
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
};

// Returns [{ name, version, license, text, from }] for the packages in a bundle.
export const bundledPackages = (metafile, cwd) => {
  const dirs = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const dir = packageDirOf(path.resolve(cwd, input));
    if (dir) dirs.add(dir);
  }
  return collectNotices(dirs);
};

const fence = (text) => `\`\`\`\n${text.replace(/```/g, "'''")}\n\`\`\``;

export const renderNotices = ({ title, intro, packages, extra = [] }) =>
  [
    `# ${title}`,
    "",
    intro,
    "",
    ...packages.flatMap((item) => [`## ${item.name} ${item.version}`, "", `License: ${item.license} (text from ${item.from})`, "", fence(item.text), ""]),
    ...extra.flatMap((item) => [`## ${item.name}`, "", item.note, "", fence(item.text), ""]),
  ].join("\n");

// The Node.js license for a binary that embeds this Node. Release builds use
// the official Node tarball (its LICENSE sits next to bin/); local builds
// can point NODE_LICENSE_FILE at the LICENSE of the same Node version.
export const nodeLicense = () => {
  // Official layouts: <dir>/bin/node with <dir>/LICENSE (macOS, Linux) and
  // <dir>/node.exe with <dir>/LICENSE (Windows).
  const candidates = [
    process.env.NODE_LICENSE_FILE,
    path.join(path.dirname(path.dirname(process.execPath)), "LICENSE"),
    path.join(path.dirname(process.execPath), "LICENSE"),
  ].filter(Boolean);
  const file = candidates.find((item) => existsSync(item));
  if (!file) {
    throw new Error(`Node.js ${process.version} LICENSE not found next to ${process.execPath}. Download https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE and set NODE_LICENSE_FILE to it.`);
  }
  const text = readFileSync(file, "utf8").trim();
  if (!/^Node\.js is licensed for use as follows/m.test(text)) throw new Error(`${file} doesn't look like the Node.js LICENSE.`);
  return { file, text };
};
