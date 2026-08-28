import { type } from "arktype";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const FormulaRenames = type({ "[string]": "string" });

type Platform = "macos-arm64" | "macos-x64" | "linux-arm64" | "linux-x64";

export interface HomebrewRelease {
  version: string;
  checksums: Record<Platform, string>;
}

const releaseURL = (version: string, platform: Platform): string =>
  `https://github.com/corbitsdev/corbits-code/releases/download/v${version}/corbits-${version}-${platform}.tar.gz`;

function renderFormula(release: HomebrewRelease): string {
  const source = (
    platform: Platform,
  ): string => `      url "${releaseURL(release.version, platform)}"
      sha256 "${release.checksums[platform]}"`;

  return `class CorbitsCode < Formula
  desc "Single-process coding agent CLI built on the Interchange runtime"
  homepage "https://github.com/corbitsdev/corbits-code"
  version "${release.version}"
  license "GPL-2.0-only"

  on_macos do
    on_arm do
${source("macos-arm64")}
    end
    on_intel do
${source("macos-x64")}
    end
  end

  on_linux do
    on_arm do
${source("linux-arm64")}
    end
    on_intel do
${source("linux-x64")}
    end
  end

  def install
    bin.install "corbits"
    if File.directory?("plugins")
      (bin/"plugins").mkpath
      cp_r "plugins/.", bin/"plugins"
    end
  end

  test do
    assert_predicate bin/"corbits", :executable?
  end
end
`;
}

async function readFormulaRenames(path: string): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return {};
    throw cause;
  }

  const parsed: unknown = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    throw new Error("Invalid formula rename metadata: expected an object");
  }
  const renames = FormulaRenames(parsed);
  if (renames instanceof type.errors) {
    throw new Error(`Invalid formula rename metadata: ${renames.summary}`);
  }
  return renames;
}

export async function generateHomebrewTap(tapDir: string, release: HomebrewRelease): Promise<void> {
  const formulaDir = join(tapDir, "Formula");
  const renamesPath = join(tapDir, "formula_renames.json");
  const formula = renderFormula(release);
  const renames = await readFormulaRenames(renamesPath);
  renames.corbits = "corbits-code";
  const renameMetadata = `${JSON.stringify(renames, null, 2)}\n`;

  await mkdir(formulaDir, { recursive: true });
  await rm(join(formulaDir, "corbits.rb"), { force: true });
  await writeFile(join(formulaDir, "corbits-code.rb"), formula);
  await writeFile(renamesPath, renameMetadata);
}

function parseRelease(args: string[]): { tapDir: string; release: HomebrewRelease } {
  if (args.length !== 6) {
    throw new Error(
      "usage: generate-homebrew-tap.ts TAP_DIR VERSION MACOS_ARM64 MACOS_X64 LINUX_ARM64 LINUX_X64",
    );
  }
  const [tapDir, version, macosArm64, macosX64, linuxArm64, linuxX64] = args;
  if (!tapDir || !version || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("version must be X.Y.Z");
  }
  const isChecksum = (value: string | undefined): value is string =>
    value !== undefined && /^[0-9a-f]{64}$/.test(value);
  if (
    !isChecksum(macosArm64) ||
    !isChecksum(macosX64) ||
    !isChecksum(linuxArm64) ||
    !isChecksum(linuxX64)
  ) {
    throw new Error("invalid SHA-256 checksum");
  }

  return {
    tapDir,
    release: {
      version,
      checksums: {
        "macos-arm64": macosArm64,
        "macos-x64": macosX64,
        "linux-arm64": linuxArm64,
        "linux-x64": linuxX64,
      },
    },
  };
}

if (import.meta.main) {
  const { tapDir, release } = parseRelease(process.argv.slice(2));
  await generateHomebrewTap(tapDir, release);
}
