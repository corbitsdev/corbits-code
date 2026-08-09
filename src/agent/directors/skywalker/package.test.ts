import { describe, expect, test } from "bun:test";
import { createSkywalkerSystemPrompt, skywalkerPackage } from "./package.js";

describe("skywalkerPackage", () => {
  test("id matches directory", () => {
    expect(skywalkerPackage.id).toBe("skywalker");
  });

  test("systemPrompt is real, not placeholder", () => {
    expect(skywalkerPackage.systemPrompt.length).toBeGreaterThan(0);
    expect(skywalkerPackage.systemPrompt.startsWith("Placeholder")).toBe(false);
    expect(skywalkerPackage.systemPrompt).toContain("PRIMARY INTENT");
    expect(skywalkerPackage.systemPrompt).toContain("NEVER implement");
  });

  test("createSkywalkerSystemPrompt returns package systemPrompt", () => {
    expect(createSkywalkerSystemPrompt()).toBe(skywalkerPackage.systemPrompt);
  });

  test("maySpawn true with full closed allowlist", () => {
    expect(skywalkerPackage.spawn.maySpawn).toBe(true);
    expect(skywalkerPackage.spawn.allowlist).toHaveLength(15);
    expect(skywalkerPackage.spawn.allowlist).toEqual([
      "implement",
      "explore",
      "plan",
      "intern",
      "critique",
      "greybeard",
      "neckbeard",
      "bruckheimer",
      "gaasbot",
      "draper",
      "emil",
      "brand-reviewer",
      "shakespeare",
      "testsmith",
      "tester",
    ]);
  });

  test("denies product write tools", () => {
    const deny = skywalkerPackage.tools?.deny ?? [];
    expect(deny).toContain("write_file");
    expect(deny).toContain("edit_file");
    expect(deny).toContain("delete_file");
  });

  test("report required sections", () => {
    expect(skywalkerPackage.report.requiredSections).toEqual([
      "Summary",
      "Findings",
      "Blockers",
      "Paths",
    ]);
  });

  test("modelRole is orchestrator", () => {
    expect(skywalkerPackage.modelRole).toBe("orchestrator");
  });

  test("optionalSkills order", () => {
    expect(skywalkerPackage.optionalSkills).toEqual([
      "dispatch",
      "style",
      "philosophy",
      "interview",
    ]);
  });

  test("primaryIntent and outOfLane", () => {
    expect(skywalkerPackage.primaryIntent).toBe(
      "Orchestrate only — triage and dispatch; do not implement product code",
    );
    expect(skywalkerPackage.outOfLane).toContain("product edits");
    expect(skywalkerPackage.outOfLane).toContain("general catch-all leaf");
  });

  test("nudge maxTurns", () => {
    expect(skywalkerPackage.nudge?.maxTurns).toBe(100);
  });
});
