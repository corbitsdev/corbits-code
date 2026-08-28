import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateHomebrewTap } from "../../scripts/generate-homebrew-tap.js";

const pkg = {
  repo: "corbitsdev/corbits-code",
  binary: "corbits",
  formula: "corbits-code",
  description: "Single-process coding agent CLI built on the Interchange runtime",
};

const release = {
  version: "1.2.3",
  checksums: {
    "macos-arm64": "a".repeat(64),
    "macos-x64": "b".repeat(64),
    "linux-arm64": "c".repeat(64),
    "linux-x64": "d".repeat(64),
  },
};

describe("generateHomebrewTap", () => {
  let tapDir: string;

  beforeEach(async () => {
    tapDir = await mkdtemp(join(tmpdir(), "corbits-homebrew-tap-"));
  });

  afterEach(async () => {
    await rm(tapDir, { recursive: true, force: true });
  });

  test("replaces the legacy formula with corbits-code and installs corbits", async () => {
    const formulaDir = join(tapDir, "Formula");
    await mkdir(formulaDir);
    await writeFile(join(formulaDir, "corbits.rb"), "class Corbits < Formula\nend\n");

    await generateHomebrewTap(tapDir, pkg, release);

    expect((await readdir(formulaDir)).sort()).toEqual(["corbits-code.rb"]);
    const formula = await readFile(join(formulaDir, "corbits-code.rb"), "utf8");
    expect(formula).toContain("class CorbitsCode < Formula");
    expect(formula).toContain('version "1.2.3"');
    expect(formula).toContain('bin.install "corbits"');
    expect(formula).not.toContain('bin.install "corbits-code"');
  });

  test("rejects invalid rename metadata before changing formulas", async () => {
    const invalidMetadata = ["[]\n", '{"other": 42}\n'];

    for (const [index, metadata] of invalidMetadata.entries()) {
      const caseDir = join(tapDir, `invalid-${index}`);
      const formulaDir = join(caseDir, "Formula");
      const legacyFormula = "class Corbits < Formula\nend\n";
      const currentFormula = "class CorbitsCode < Formula\nend\n";
      await mkdir(formulaDir, { recursive: true });
      await writeFile(join(formulaDir, "corbits.rb"), legacyFormula);
      await writeFile(join(formulaDir, "corbits-code.rb"), currentFormula);
      await writeFile(join(caseDir, "formula_renames.json"), metadata);

      await expect(generateHomebrewTap(caseDir, pkg, release)).rejects.toThrow(
        "Invalid formula rename metadata",
      );

      expect(await readFile(join(formulaDir, "corbits.rb"), "utf8")).toBe(legacyFormula);
      expect(await readFile(join(formulaDir, "corbits-code.rb"), "utf8")).toBe(currentFormula);
    }
  });

  test("merges formula rename metadata without changing repeated output", async () => {
    await writeFile(
      join(tapDir, "formula_renames.json"),
      `${JSON.stringify({ retained: "other-formula" }, null, 2)}\n`,
    );

    await generateHomebrewTap(tapDir, pkg, release);

    const first = await readFile(join(tapDir, "formula_renames.json"), "utf8");
    expect(JSON.parse(first)).toEqual({
      retained: "other-formula",
      corbits: "corbits-code",
    });

    await generateHomebrewTap(tapDir, pkg, release);
    expect(await readFile(join(tapDir, "formula_renames.json"), "utf8")).toBe(first);
  });
});
