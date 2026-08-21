import { describe, expect, test } from "bun:test";
import { shakespearePackage } from "./package.js";

describe("shakespearePackage", () => {
  test("id matches directory / registry id", () => {
    expect(shakespearePackage.id).toBe("shakespeare");
  });

  test("systemPrompt is non-empty and not a Placeholder", () => {
    expect(shakespearePackage.systemPrompt.length).toBeGreaterThan(0);
    expect(shakespearePackage.systemPrompt.startsWith("Placeholder")).toBe(false);
  });

  test("systemPrompt owns P/A/I docs and does not interview", () => {
    const prompt = shakespearePackage.systemPrompt;
    expect(prompt).toContain("PRIMARY INTENT");
    expect(prompt).toContain("PRODUCT.md");
    expect(prompt).toContain("ARCHITECTURE.md");
    expect(prompt).toContain("IMPLEMENTATION.md");
    expect(prompt).toMatch(/cannot interview/i);
  });

  test("spawn.maySpawn is false (leaf)", () => {
    expect(shakespearePackage.spawn.maySpawn).toBe(false);
  });

  test("tools.allow includes write tools; writePaths is omitted", () => {
    const allow = shakespearePackage.tools?.allow ?? [];
    expect(allow).toContain("write_file");
    expect(allow).toContain("edit_file");
    expect(shakespearePackage.writePaths).toBeUndefined();
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

  test("required style and philosophy; optional scribe", () => {
    expect(shakespearePackage.requiredSkills).toEqual(["style", "philosophy"]);
    expect(shakespearePackage.optionalSkills).toEqual(["scribe"]);
  });

  test("nudge.maxTurns is 50", () => {
    expect(shakespearePackage.nudge?.maxTurns).toBe(50);
  });

  test("primaryIntent is docs maintain", () => {
    expect(shakespearePackage.primaryIntent).toMatch(/docs|documentation|PRODUCT|product/i);
  });
});
