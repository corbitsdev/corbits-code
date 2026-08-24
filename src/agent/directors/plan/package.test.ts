import { describe, expect, test } from "bun:test";
import { planPackage } from "./package.js";

describe("planPackage", () => {
  test("id matches directory", () => {
    expect(planPackage.id).toBe("plan");
  });

  test("systemPrompt is real (not Placeholder)", () => {
    expect(planPackage.systemPrompt.length).toBeGreaterThan(0);
    expect(planPackage.systemPrompt.startsWith("Placeholder")).toBe(false);
  });

  test("systemPrompt states PRIMARY INTENT", () => {
    expect(planPackage.systemPrompt).toMatch(/PRIMARY INTENT/i);
  });

  test("spawn.maySpawn is false", () => {
    expect(planPackage.spawn.maySpawn).toBe(false);
  });

  test("tools.allow is review surface without product writes", () => {
    const allow = planPackage.tools?.allow ?? [];
    expect(allow).toContain("read_file");
    expect(allow).not.toContain("write_file");
    expect(allow).not.toContain("edit_file");
    expect(allow).not.toContain("delete_file");
  });

  test("modelRole is plan", () => {
    expect(planPackage.modelRole).toBe("plan");
  });

  test("optionalSkills order", () => {
    expect(planPackage.optionalSkills).toEqual(["style", "philosophy", "interview"]);
  });

  test("primaryIntent and outOfLane match plan lane", () => {
    expect(planPackage.primaryIntent).toBe("Author eng change plans; do not implement");
    expect(planPackage.outOfLane).toContain("shipping code");
    expect(planPackage.outOfLane).toContain("architecture gate sign-off as Greybeard");
    expect(planPackage.outOfLane).toContain("running the fleet");
  });
});
