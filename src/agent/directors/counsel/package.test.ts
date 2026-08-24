import { describe, expect, test } from "bun:test";
import { counselPackage } from "./package.js";

describe("counselPackage", () => {
  test("id matches directory", () => {
    expect(counselPackage.id).toBe("counsel");
  });

  test("systemPrompt is real (not Placeholder)", () => {
    expect(counselPackage.systemPrompt.length).toBeGreaterThan(0);
    expect(counselPackage.systemPrompt.startsWith("Placeholder")).toBe(false);
  });

  test("systemPrompt states PRIMARY INTENT", () => {
    expect(counselPackage.systemPrompt).toMatch(/PRIMARY INTENT/i);
  });

  test("spawn.maySpawn is false", () => {
    expect(counselPackage.spawn.maySpawn).toBe(false);
  });

  test("tools.allow is review surface with product writes", () => {
    const allow = counselPackage.tools?.allow ?? [];
    expect(allow).toContain("read_file");
    expect(allow).toContain("write_file");
    expect(allow).toContain("edit_file");
    expect(allow).toContain("delete_file");
  });

  test("modelRole is plan", () => {
    expect(counselPackage.modelRole).toBe("plan");
  });

  test("optionalSkills order", () => {
    expect(counselPackage.optionalSkills).toEqual(["style", "philosophy", "interview"]);
  });

  test("primaryIntent and outOfLane match plan lane", () => {
    expect(counselPackage.primaryIntent).toBe("Author eng change plans; do not implement");
    expect(counselPackage.outOfLane).toContain("shipping code");
    expect(counselPackage.outOfLane).toContain("architecture gate sign-off as Greybeard");
    expect(counselPackage.outOfLane).toContain("running the fleet");
  });
});
