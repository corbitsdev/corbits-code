import { describe, expect, test } from "bun:test";
import { critiquePackage } from "./package.js";

describe("critiquePackage", () => {
  test("id matches directory", () => {
    expect(critiquePackage.id).toBe("critique");
  });

  test("systemPrompt is real, not a placeholder", () => {
    expect(critiquePackage.systemPrompt.length).toBeGreaterThan(0);
    expect(critiquePackage.systemPrompt.startsWith("Placeholder")).toBe(false);
  });

  test("systemPrompt states PRIMARY INTENT", () => {
    expect(critiquePackage.systemPrompt).toMatch(/PRIMARY INTENT/i);
  });

  test("systemPrompt is evidence-based and never-fix", () => {
    expect(critiquePackage.systemPrompt).toMatch(/evidence-based/i);
    expect(critiquePackage.systemPrompt).toMatch(/never fix/i);
    expect(critiquePackage.systemPrompt).toMatch(/tmp\/critique-tests/);
    expect(critiquePackage.systemPrompt).toMatch(/permanent tests/i);
  });

  test("spawn.maySpawn is false", () => {
    expect(critiquePackage.spawn.maySpawn).toBe(false);
  });

  test("tools.deny blocks product write paths", () => {
    const deny = critiquePackage.tools?.deny ?? [];
    expect(deny).toContain("write_file");
    expect(deny).toContain("edit_file");
    expect(deny).toContain("delete_file");
  });

  test("report.requiredSections covers the leaf envelope", () => {
    const sections = critiquePackage.report.requiredSections;
    expect(sections).toContain("Summary");
    expect(sections).toContain("Findings");
    expect(sections).toContain("Blockers");
    expect(sections).toContain("Paths");
  });

  test("modelRole is review", () => {
    expect(critiquePackage.modelRole).toBe("review");
  });

  test("optionalSkills order is style, philosophy", () => {
    expect(critiquePackage.optionalSkills).toEqual(["style", "philosophy"]);
  });

  test("primaryIntent and outOfLane match critique lane", () => {
    expect(critiquePackage.primaryIntent).toBe(
      "Evidence-based code review; never fix product code",
    );
    expect(critiquePackage.outOfLane).toContain("implementing fixes");
    expect(critiquePackage.outOfLane).toContain("architecture portfolio without code evidence");
    expect(critiquePackage.outOfLane).toContain("visual brand");
    expect(critiquePackage.outOfLane).toContain("DESIGN.md");
    expect(critiquePackage.outOfLane).toContain("pedantic fun without evidence");
  });

  test("nudge maxTurns is 45", () => {
    expect(critiquePackage.nudge?.maxTurns).toBe(45);
  });
});
