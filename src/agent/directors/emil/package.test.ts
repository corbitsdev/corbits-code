import { describe, expect, test } from "bun:test";
import { emilPackage } from "./package.js";

describe("emilPackage", () => {
  test("id matches directory", () => {
    expect(emilPackage.id).toBe("emil");
  });

  test("systemPrompt is real, not a placeholder", () => {
    expect(emilPackage.systemPrompt.length).toBeGreaterThan(0);
    expect(emilPackage.systemPrompt.startsWith("Placeholder")).toBe(false);
  });

  test("systemPrompt states PRIMARY INTENT", () => {
    expect(emilPackage.systemPrompt).toMatch(/PRIMARY INTENT/i);
    expect(emilPackage.systemPrompt).toContain("build (fixes)");
  });

  test("spawn.maySpawn is false", () => {
    expect(emilPackage.spawn.maySpawn).toBe(false);
  });

  test("tools.allow is review surface without product writes", () => {
    const allow = emilPackage.tools?.allow ?? [];
    expect(allow).toContain("read_file");
    expect(allow).not.toContain("write_file");
    expect(allow).not.toContain("edit_file");
    expect(allow).not.toContain("delete_file");
  });

  test("modelRole is review", () => {
    expect(emilPackage.modelRole).toBe("review");
  });

  test("primaryIntent and outOfLane match emil lane", () => {
    expect(emilPackage.primaryIntent).toBe(
      "Design-engineering + laws from a development perspective",
    );
    expect(emilPackage.outOfLane).toContain("shipping product code without design brief");
    expect(emilPackage.outOfLane).toContain("marketing content");
  });
});
