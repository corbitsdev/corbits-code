import { describe, expect, test } from "bun:test";
import { draperPackage } from "./package.js";

describe("draperPackage", () => {
  test("id matches directory", () => {
    expect(draperPackage.id).toBe("draper");
  });

  test("systemPrompt is real, not a placeholder", () => {
    expect(draperPackage.systemPrompt.length).toBeGreaterThan(0);
    expect(draperPackage.systemPrompt.startsWith("Placeholder")).toBe(false);
  });

  test("systemPrompt states PRIMARY INTENT", () => {
    expect(draperPackage.systemPrompt).toMatch(/PRIMARY INTENT/i);
  });

  test("spawn.maySpawn is false", () => {
    expect(draperPackage.spawn.maySpawn).toBe(false);
  });

  test("tools.deny blocks product write paths", () => {
    const deny = draperPackage.tools?.deny ?? [];
    expect(deny).toContain("write_file");
    expect(deny).toContain("edit_file");
    expect(deny).toContain("delete_file");
  });

  test("report.requiredSections covers the leaf envelope", () => {
    const sections = draperPackage.report.requiredSections;
    expect(sections).toContain("Summary");
    expect(sections).toContain("Findings");
    expect(sections).toContain("Blockers");
    expect(sections).toContain("Paths");
  });

  test("modelRole is review", () => {
    expect(draperPackage.modelRole).toBe("review");
  });

  test("primaryIntent and outOfLane match draper lane", () => {
    expect(draperPackage.primaryIntent).toBe(
      "Product visual/CBS critique from a development perspective",
    );
    expect(draperPackage.outOfLane).toContain("shipping product code");
    expect(draperPackage.outOfLane).toContain("marketing copy pipeline");
  });

  test("nudge maxTurns is 40", () => {
    expect(draperPackage.nudge?.maxTurns).toBe(40);
  });
});
