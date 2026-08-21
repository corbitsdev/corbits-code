import { describe, expect, test } from "bun:test";
import { gaasbotPackage } from "./package.js";

describe("gaasbotPackage", () => {
  test("id matches directory", () => {
    expect(gaasbotPackage.id).toBe("gaasbot");
  });

  test("systemPrompt is real (not Placeholder)", () => {
    expect(gaasbotPackage.systemPrompt.length).toBeGreaterThan(0);
    expect(gaasbotPackage.systemPrompt.startsWith("Placeholder")).toBe(false);
  });

  test("systemPrompt states PRIMARY INTENT", () => {
    expect(gaasbotPackage.systemPrompt).toMatch(/PRIMARY INTENT/i);
  });

  test("spawn.maySpawn is false", () => {
    expect(gaasbotPackage.spawn.maySpawn).toBe(false);
  });

  test("denies product write tools (advice only)", () => {
    const allow = gaasbotPackage.tools?.allow ?? [];
    expect(allow).toContain("read_file");
    expect(allow).not.toContain("write_file");
    expect(allow).not.toContain("edit_file");
    expect(allow).not.toContain("delete_file");
  });

  test("report requires envelope sections", () => {
    for (const section of ["Summary", "Findings", "Blockers", "Paths"]) {
      expect(gaasbotPackage.report.requiredSections).toContain(section);
    }
  });

  test("modelRole is plan", () => {
    expect(gaasbotPackage.modelRole).toBe("plan");
  });

  test("required philosophy; optional style", () => {
    expect(gaasbotPackage.requiredSkills).toEqual(["philosophy"]);
    expect(gaasbotPackage.optionalSkills).toEqual(["style"]);
  });

  test("primaryIntent and outOfLane match CTO advice lane", () => {
    expect(gaasbotPackage.primaryIntent).toMatch(/CTO advice/i);
    expect(gaasbotPackage.outOfLane).toContain("blocking merges");
    expect(gaasbotPackage.outOfLane).toContain("shipping product code as implementer");
  });

  test("nudge maxTurns is 35", () => {
    expect(gaasbotPackage.nudge?.maxTurns).toBe(35);
  });
});
