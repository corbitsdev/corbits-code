import { describe, expect, test } from "bun:test";

import { internPackage } from "./package.js";

describe("internPackage", () => {
  test("id matches directory", () => {
    expect(internPackage.id).toBe("intern");
  });

  test("systemPrompt is real (not placeholder)", () => {
    expect(internPackage.systemPrompt.length).toBeGreaterThan(0);
    expect(internPackage.systemPrompt.startsWith("Placeholder")).toBe(false);
    expect(internPackage.systemPrompt).toMatch(/PRIMARY INTENT/i);
  });

  test("spawn.maySpawn is false", () => {
    expect(internPackage.spawn.maySpawn).toBe(false);
  });

  test("nudge.maxTurns is 20", () => {
    expect(internPackage.nudge?.maxTurns).toBe(20);
  });

  test("tools.deny blocks product writes, search, and task", () => {
    const deny = internPackage.tools?.deny ?? [];
    for (const name of ["write_file", "edit_file", "delete_file", "grep", "search_files", "task"]) {
      expect(deny).toContain(name);
    }
  });

  test("report.requiredSections envelope", () => {
    for (const section of ["Summary", "Findings", "Blockers", "Paths"]) {
      expect(internPackage.report.requiredSections).toContain(section);
    }
  });

  test("modelRole is implement", () => {
    expect(internPackage.modelRole).toBe("implement");
  });

  test("optionalSkills is empty by default", () => {
    expect(internPackage.optionalSkills).toEqual([]);
  });

  test("primaryIntent and description", () => {
    expect(internPackage.primaryIntent).toContain("Mechanical shell/commands only");
    expect(internPackage.description).toBe("Mechanical intern leaf");
  });
});
