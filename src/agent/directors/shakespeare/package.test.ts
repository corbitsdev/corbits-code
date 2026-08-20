import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { matchesWritePathAllowlist } from "../../../permission/write-path-policy.js";
import { shakespearePackage } from "./package.js";

const cwd = resolve("/tmp/shakespeare-write-path-fixture");

describe("shakespearePackage", () => {
  test("id matches directory / registry id", () => {
    expect(shakespearePackage.id).toBe("shakespeare");
  });

  test("systemPrompt is non-empty and not a Placeholder", () => {
    expect(shakespearePackage.systemPrompt.length).toBeGreaterThan(0);
    expect(shakespearePackage.systemPrompt.startsWith("Placeholder")).toBe(false);
  });

  test("systemPrompt names Shakespeare and states PRIMARY INTENT", () => {
    expect(shakespearePackage.systemPrompt).toMatch(/Shakespeare/i);
    expect(shakespearePackage.systemPrompt).toContain("PRIMARY INTENT");
    expect(shakespearePackage.systemPrompt).toMatch(/product/i);
    expect(shakespearePackage.systemPrompt).toMatch(/architecture/i);
    expect(shakespearePackage.systemPrompt).toMatch(/implementation/i);
  });

  test("systemPrompt bakes scribe workflow without requiring use_skill scribe", () => {
    const prompt = shakespearePackage.systemPrompt;
    expect(prompt).toMatch(/Document discovery|document discovery/i);
    expect(prompt).toMatch(/gap/i);
    expect(prompt).toMatch(/cross-document|cross-doc|consistency/i);
    expect(prompt).toMatch(/interview|question/i);
    expect(prompt).not.toMatch(/use_skill\s*\(\s*["']scribe["']\s*\)/);
  });

  test("spawn.maySpawn is false (leaf)", () => {
    expect(shakespearePackage.spawn.maySpawn).toBe(false);
  });

  test("tools.allow includes write tools; writePaths lock docs", () => {
    const allow = shakespearePackage.tools?.allow ?? [];
    expect(allow).toContain("write_file");
    expect(allow).toContain("edit_file");
    expect(shakespearePackage.writePaths).toEqual([
      "PRODUCT.md",
      "ARCHITECTURE.md",
      "IMPLEMENTATION.md",
      "docs/PRODUCT.md",
      "docs/ARCHITECTURE.md",
      "docs/IMPLEMENTATION.md",
    ]);
  });

  test("writePaths match the docs trio at root and under docs/, not TUI", () => {
    const allow = shakespearePackage.writePaths ?? [];
    expect(matchesWritePathAllowlist("docs/ARCHITECTURE.md", allow, cwd)).toBe(true);
    expect(matchesWritePathAllowlist("docs/PRODUCT.md", allow, cwd)).toBe(true);
    expect(matchesWritePathAllowlist("docs/IMPLEMENTATION.md", allow, cwd)).toBe(true);
    expect(matchesWritePathAllowlist("ARCHITECTURE.md", allow, cwd)).toBe(true);
    expect(matchesWritePathAllowlist("docs/TUI.md", allow, cwd)).toBe(false);
  });

  test("report.requiredSections includes Summary, Findings, Blockers, Paths", () => {
    const sections = shakespearePackage.report.requiredSections;
    expect(sections).toContain("Summary");
    expect(sections).toContain("Findings");
    expect(sections).toContain("Blockers");
    expect(sections).toContain("Paths");
  });

  test("modelRole is docs", () => {
    expect(shakespearePackage.modelRole).toBe("docs");
  });

  test("optionalSkills are style and philosophy", () => {
    expect(shakespearePackage.optionalSkills).toEqual(["style", "philosophy"]);
  });

  test("nudge.maxTurns is 50", () => {
    expect(shakespearePackage.nudge?.maxTurns).toBe(50);
  });

  test("primaryIntent is docs maintain", () => {
    expect(shakespearePackage.primaryIntent).toMatch(/docs|documentation|PRODUCT|product/i);
  });
});
