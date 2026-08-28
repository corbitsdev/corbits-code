import { type } from "arktype";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const FormulaRenames = type({ "[string]": "string" });

type Platform = "macos-arm64" | "macos-x64" | "linux-arm64" | "linux-x64";

export interface HomebrewRelease {
  version: string;
  checksums: Record<Platform, string>;
}

/** Release facts owned by scripts/release.sh; passed in so they live in one place. */
export interface HomebrewPackage {
  repo: string; // GitHub owner/name
  binary: string; // CLI binary, tarball stem, and legacy formula name
  formula: string; // `brew install` name
  description: string;
}

const formulaClass = (formula: string): string =>
  formula.replace(/(?:^|-)([a-z])/g, (_, c: string) => c.toUpperCase());

function renderFormula(pkg: HomebrewPackage, release: HomebrewRelease): string {
  const source = (
    platform: Platform,
  ): string => `      url "https://github.com/${pkg.repo}/releases/download/v${release.version}/${pkg.binary}-${release.version}-${platform}.tar.gz"
      sha256 "${release.checksums[platform]}"`;

  return `class ${formulaClass(pkg.formula)} < Formula
  desc "${pkg.description}"
  homepage "https://github.com/${pkg.repo}"
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
    bin.install "${pkg.binary}"
    if File.directory?("plugins")
      (bin/"plugins").mkpath
      cp_r "plugins/.", bin/"plugins"
    end
  end

  test do
    assert_predicate bin/"${pkg.binary}", :executable?
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

export async function generateHomebrewTap(
  tapDir: string,
  pkg: HomebrewPackage,
  release: HomebrewRelease,
): Promise<void> {
  const formulaDir = join(tapDir, "Formula");
  const renamesPath = join(tapDir, "formula_renames.json");
  const formula = renderFormula(pkg, release);
  const renames = await readFormulaRenames(renamesPath);
  renames[pkg.binary] = pkg.formula;
  const renameMetadata = `${JSON.stringify(renames, null, 2)}\n`;

  await mkdir(formulaDir, { recursive: true });
  await rm(join(formulaDir, `${pkg.binary}.rb`), { force: true });
  await writeFile(join(formulaDir, `${pkg.formula}.rb`), formula);
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

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name} (set by scripts/release.sh)`);
  return value;
}

if (import.meta.main) {
  const { tapDir, release } = parseRelease(process.argv.slice(2));
  await generateHomebrewTap(
    tapDir,
    {
      repo: requireEnv("MAIN_REPO"),
      binary: requireEnv("BINARY"),
      formula: requireEnv("BREW_FORMULA"),
      description: requireEnv("DESC"),
    },
    release,
  );
}
