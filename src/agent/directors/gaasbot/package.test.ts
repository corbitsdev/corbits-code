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

  test("mounts product write tools (lane discipline in prompts)", () => {
    const allow = gaasbotPackage.tools?.allow ?? [];
    expect(allow).toContain("read_file");
    expect(allow).toContain("write_file");
    expect(allow).toContain("edit_file");
    expect(allow).toContain("delete_file");
  });

  test("modelRole is plan", () => {
    expect(gaasbotPackage.modelRole).toBe("plan");
  });

  test("optionalSkills is philosophy only", () => {
    expect(gaasbotPackage.optionalSkills).toEqual(["philosophy"]);
  });

  test("primaryIntent and outOfLane match CTO advice lane", () => {
    expect(gaasbotPackage.primaryIntent).toMatch(/CTO advice/i);
    expect(gaasbotPackage.outOfLane).toContain("blocking merges");
    expect(gaasbotPackage.outOfLane).toContain("shipping product code as implementer");
  });
});
