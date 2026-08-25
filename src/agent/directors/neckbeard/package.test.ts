import { describe, expect, test } from "bun:test";
import { neckbeardPackage } from "./package.js";

describe("neckbeardPackage", () => {
  test("id matches directory", () => {
    expect(neckbeardPackage.id).toBe("neckbeard");
  });

  test("systemPrompt is real (not Placeholder)", () => {
    expect(neckbeardPackage.systemPrompt.length).toBeGreaterThan(0);
    expect(neckbeardPackage.systemPrompt.startsWith("Placeholder")).toBe(false);
  });

  test("systemPrompt states PRIMARY INTENT", () => {
    expect(neckbeardPackage.systemPrompt).toMatch(/PRIMARY INTENT/i);
  });

  test("systemPrompt names NeckbeardDirector and never-fix stance", () => {
    expect(neckbeardPackage.systemPrompt).toMatch(/NeckbeardDirector/);
    expect(neckbeardPackage.systemPrompt).toMatch(/never fix/i);
    expect(neckbeardPackage.systemPrompt).toContain("builder (to fix)");
  });

  test("spawn.maySpawn is false", () => {
    expect(neckbeardPackage.spawn.maySpawn).toBe(false);
  });

  test("mounts product write tools", () => {
    const allow = neckbeardPackage.tools?.allow ?? [];
    expect(allow).toContain("read_file");
    expect(allow).toContain("write_file");
    expect(allow).toContain("edit_file");
    expect(allow).toContain("delete_file");
  });

  test("modelRole is review", () => {
    expect(neckbeardPackage.modelRole).toBe("review");
  });

  test("optionalSkills are style and philosophy", () => {
    expect(neckbeardPackage.optionalSkills).toEqual(["style", "philosophy"]);
  });

  test("primaryIntent and outOfLane match neckbeard lane", () => {
    expect(neckbeardPackage.primaryIntent).toBe("Adversarial pedantic review; never fix");
    expect(neckbeardPackage.outOfLane).toContain("applying fixes");
    expect(neckbeardPackage.outOfLane).toContain("product implementation");
    expect(neckbeardPackage.outOfLane).toContain("architecture ownership");
  });
});
