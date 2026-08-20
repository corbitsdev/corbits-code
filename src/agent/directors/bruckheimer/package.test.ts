import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { matchesWritePathAllowlist } from "../../../permission/write-path-policy.js";
import { bruckheimerPackage } from "./package.js";

const cwd = resolve("/tmp/bruckheimer-write-path-fixture");

describe("bruckheimerPackage", () => {
  test("id matches directory", () => {
    expect(bruckheimerPackage.id).toBe("bruckheimer");
  });

  test("systemPrompt is real (not Placeholder)", () => {
    expect(bruckheimerPackage.systemPrompt.length).toBeGreaterThan(0);
    expect(bruckheimerPackage.systemPrompt.startsWith("Placeholder")).toBe(false);
  });

  test("systemPrompt states PRIMARY INTENT", () => {
    expect(bruckheimerPackage.systemPrompt).toMatch(/PRIMARY INTENT/i);
  });

  test("spawn.maySpawn is false", () => {
    expect(bruckheimerPackage.spawn.maySpawn).toBe(false);
  });

  test("tools.allow includes write tools; writePaths lock discovery docs", () => {
    const allow = bruckheimerPackage.tools?.allow ?? [];
    expect(allow).toContain("write_file");
    expect(allow).toContain("edit_file");
    expect(bruckheimerPackage.writePaths).toEqual(["PRODUCT.md", "docs/PRODUCT.md"]);
  });

  test("writePaths match product docs only, not architecture or TUI", () => {
    const allow = bruckheimerPackage.writePaths ?? [];
    expect(matchesWritePathAllowlist("PRODUCT.md", allow, cwd)).toBe(true);
    expect(matchesWritePathAllowlist("docs/PRODUCT.md", allow, cwd)).toBe(true);
    expect(matchesWritePathAllowlist("docs/ARCHITECTURE.md", allow, cwd)).toBe(false);
    expect(matchesWritePathAllowlist("docs/IMPLEMENTATION.md", allow, cwd)).toBe(false);
    expect(matchesWritePathAllowlist("docs/TUI.md", allow, cwd)).toBe(false);
  });

  test("report requires envelope sections", () => {
    for (const section of ["Summary", "Findings", "Blockers", "Paths"]) {
      expect(bruckheimerPackage.report.requiredSections).toContain(section);
    }
  });

  test("modelRole is docs", () => {
    expect(bruckheimerPackage.modelRole).toBe("docs");
  });

  test("primaryIntent and outOfLane match discovery lane", () => {
    expect(bruckheimerPackage.primaryIntent).toMatch(/product discovery/i);
    expect(bruckheimerPackage.outOfLane).toContain("shipping product code");
    expect(bruckheimerPackage.outOfLane).toContain("architecture gates");
  });

  test("nudge maxTurns is 40", () => {
    expect(bruckheimerPackage.nudge?.maxTurns).toBe(40);
  });
});
