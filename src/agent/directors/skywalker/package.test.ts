import { describe, expect, test } from "bun:test";
import { createSkywalkerSystemPrompt, skywalkerPackage } from "./package.js";

describe("skywalkerPackage", () => {
  test("id matches directory", () => {
    expect(skywalkerPackage.id).toBe("skywalker");
  });

  test("systemPrompt is a short roster, not a playbook", () => {
    expect(skywalkerPackage.systemPrompt.length).toBeGreaterThan(0);
    expect(skywalkerPackage.systemPrompt.startsWith("Placeholder")).toBe(false);
    expect(skywalkerPackage.systemPrompt).toContain("You are Skywalker");
    expect(skywalkerPackage.systemPrompt).toContain("When asked your name, answer: Skywalker");
    expect(skywalkerPackage.systemPrompt).toContain("PRIMARY INTENT");
    expect(skywalkerPackage.systemPrompt).toContain("You may edit files");
    expect(skywalkerPackage.systemPrompt).toContain("You may chain agents");
    expect(skywalkerPackage.systemPrompt).toContain("Match operator tone");
    expect(skywalkerPackage.systemPrompt).not.toContain("NEVER implement");
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

  test("tools.allow mounts writes and dispatch", () => {
    const allow = skywalkerPackage.tools?.allow ?? [];
    expect(allow).toContain("task");
    expect(allow).toContain("search_agents");
    expect(allow).toContain("write_file");
    expect(allow).toContain("edit_file");
    expect(allow).toContain("delete_file");
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
    expect(skywalkerPackage.primaryIntent).toContain("Do the work");
    expect(skywalkerPackage.outOfLane).toContain("catch-all worker");
    expect(skywalkerPackage.outOfLane).toContain("waiting for the operator to name a director");
    expect(skywalkerPackage.outOfLane).not.toContain("product edits");
  });

  test("nudge maxTurns", () => {
    expect(skywalkerPackage.nudge?.maxTurns).toBe(100);
  });

  test("systemPrompt lists every spawnable director", () => {
    const p = skywalkerPackage.systemPrompt;
    for (const id of skywalkerPackage.spawn.allowlist ?? []) {
      expect(p).toContain(id);
    }
    expect(p).toContain('Never task(agent="skywalker")');
    expect(p).toMatch(/No catch-all worker/i);
  });

  test("systemPrompt treats slash actions as optional", () => {
    const p = skywalkerPackage.systemPrompt;
    expect(p).toContain("optional explicit recipes");
  });

  test("systemPrompt does not use leaf jargon", () => {
    expect(skywalkerPackage.systemPrompt).not.toMatch(/\bleaf\b/i);
    expect(skywalkerPackage.systemPrompt).not.toMatch(/\bleaves\b/i);
  });
});
