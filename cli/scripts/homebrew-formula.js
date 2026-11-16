// Prints the Homebrew formula for a release.
//   node scripts/homebrew-formula.js <version> <dir with storeenv-*.sha256 files>

import { readFileSync } from "node:fs";
import path from "node:path";

const [version, dir] = process.argv.slice(2);
if (!version || !dir) throw new Error("Usage: homebrew-formula.js <version> <dir>");

const base = `https://github.com/nodviking/homebrew-storeenv/releases/download/v${version}`;
const sha = (target) => readFileSync(path.join(dir, `storeenv-${target}.tar.gz.sha256`), "utf8").split(/\s+/)[0];
const block = (target) => `      url "${base}/storeenv-${target}.tar.gz"
      sha256 "${sha(target)}"`;

process.stdout.write(`class Storeenv < Formula
  desc "Git for .env files: encrypted, versioned environment secrets"
  homepage "https://storeenv.app"
  version "${version}"
  license "Apache-2.0"

  on_macos do
    on_arm do
${block("darwin-arm64")}
    end
    on_intel do
${block("darwin-x64")}
    end
  end

  on_linux do
    on_arm do
${block("linux-arm64")}
    end
    on_intel do
${block("linux-x64")}
    end
  end

  def install
    bin.install "storeenv"
    # The license and notices for StoreEnv, the bundled packages and the
    # embedded Node.js runtime (archives from 0.2.0 on carry them).
    %w[LICENSE THIRD_PARTY_NOTICES.md LICENSE-node.txt].each { |notice| doc.install notice if File.exist?(notice) }
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/storeenv --version").strip
  end
end
`);
