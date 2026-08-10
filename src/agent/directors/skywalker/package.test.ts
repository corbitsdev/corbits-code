import { describe, expect, test } from "bun:test";
import { createSkywalkerSystemPrompt, skywalkerPackage } from "./package.js";

describe("skywalkerPackage", () => {
  test("id matches directory", () => {
    expect(skywalkerPackage.id).toBe("skywalker");
  });

  test("systemPrompt is real, not placeholder", () => {
    expect(skywalkerPackage.systemPrompt.length).toBeGreaterThan(0);
    expect(skywalkerPackage.systemPrompt.startsWith("Placeholder")).toBe(false);
    expect(skywalkerPackage.systemPrompt).toContain("You are Skywalker");
    expect(skywalkerPackage.systemPrompt).toContain("When asked your name, answer: Skywalker");
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

  test("tools.allow mounts orchestrator surface without product writes", () => {
    const allow = skywalkerPackage.tools?.allow ?? [];
    expect(allow).toContain("task");
    expect(allow).toContain("search_agents");
    expect(allow).not.toContain("write_file");
    expect(allow).not.toContain("edit_file");
    expect(allow).not.toContain("delete_file");
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

  test("systemPrompt has effort scaling / fan-out ladder", () => {
    const p = skywalkerPackage.systemPrompt;
    expect(p).toContain("Effort scaling");
    expect(p).toContain("fan-out");
    expect(p).toContain("0–1 leaf");
    expect(p).toContain("2–4 leaves");
    expect(p).toContain("split ownership by path/package");
  });

  test("systemPrompt requires brief completeness for multi-leaf", () => {
    const p = skywalkerPackage.systemPrompt;
    expect(p).toContain("Brief completeness");
    expect(p).toContain("success_criteria");
    expect(p).toContain("do_not");
    expect(p).toContain("report_focus");
    expect(p).toContain("multi-leaf");
  });

  test("systemPrompt has critique-after-implement verify path", () => {
    const p = skywalkerPackage.systemPrompt;
    expect(p).toContain("Verify after ship");
    expect(p).toContain("multi-file implement");
    expect(p).toContain("critique");
    expect(p).toContain("greybeard");
    expect(p).toContain("correctness/brief gaps");
  });
});
