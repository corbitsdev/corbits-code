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
    expect(draperPackage.systemPrompt).toContain("build (fixes)");
  });

  test("spawn.maySpawn is false", () => {
    expect(draperPackage.spawn.maySpawn).toBe(false);
  });

  test("tools.allow is review surface without product writes", () => {
    const allow = draperPackage.tools?.allow ?? [];
    expect(allow).toContain("read_file");
    expect(allow).not.toContain("write_file");
    expect(allow).not.toContain("edit_file");
    expect(allow).not.toContain("delete_file");
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
});
