import { describe, expect, test } from "bun:test";
import { testsmithPackage } from "./package.js";

describe("testsmithPackage", () => {
  test("id matches directory / registry id", () => {
    expect(testsmithPackage.id).toBe("testsmith");
  });

  test("systemPrompt is non-empty and not a Placeholder", () => {
    expect(testsmithPackage.systemPrompt.length).toBeGreaterThan(0);
    expect(testsmithPackage.systemPrompt.startsWith("Placeholder")).toBe(false);
  });

  test("systemPrompt states PRIMARY INTENT for test design", () => {
    expect(testsmithPackage.systemPrompt).toContain("PRIMARY INTENT");
    expect(testsmithPackage.systemPrompt).toMatch(/test strategy|test cases|design/i);
    expect(testsmithPackage.systemPrompt).toMatch(/do not implement|not implement/i);
  });

  test("spawn.maySpawn is false (leaf)", () => {
    expect(testsmithPackage.spawn.maySpawn).toBe(false);
  });

  test("tools.deny blocks product write paths", () => {
    const deny = testsmithPackage.tools?.deny ?? [];
    expect(deny).toContain("write_file");
    expect(deny).toContain("edit_file");
    expect(deny).toContain("delete_file");
  });

  test("report.requiredSections includes Summary, Findings, Blockers, Paths", () => {
    const sections = testsmithPackage.report.requiredSections;
    expect(sections).toContain("Summary");
    expect(sections).toContain("Findings");
    expect(sections).toContain("Blockers");
    expect(sections).toContain("Paths");
  });

  test("modelRole is test", () => {
    expect(testsmithPackage.modelRole).toBe("test");
  });

  test("nudge.maxTurns is 40", () => {
    expect(testsmithPackage.nudge?.maxTurns).toBe(40);
  });

  test("primaryIntent is design-only and not primary verifier", () => {
    expect(testsmithPackage.primaryIntent).toMatch(/design/i);
    expect(testsmithPackage.primaryIntent).toMatch(/not.*verifier|do not run as primary verifier/i);
  });

  test("outOfLane refuses product implement and runtime verify role", () => {
    const joined = testsmithPackage.outOfLane.join(" ");
    expect(joined).toMatch(/implement/i);
    expect(joined).toMatch(/verifier|tester/i);
  });
});
