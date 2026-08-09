import { describe, expect, test } from "bun:test";
import { explorePackage } from "./package.js";

describe("explorePackage", () => {
  test("id matches directory", () => {
    expect(explorePackage.id).toBe("explore");
  });

  test("systemPrompt is real, not a placeholder", () => {
    expect(explorePackage.systemPrompt.length).toBeGreaterThan(0);
    expect(explorePackage.systemPrompt.startsWith("Placeholder")).toBe(false);
  });

  test("systemPrompt states PRIMARY INTENT", () => {
    expect(explorePackage.systemPrompt).toMatch(/PRIMARY INTENT/i);
  });

  test("spawn.maySpawn is false", () => {
    expect(explorePackage.spawn.maySpawn).toBe(false);
  });

  test("tools.deny blocks product write paths", () => {
    const deny = explorePackage.tools?.deny ?? [];
    expect(deny).toContain("write_file");
    expect(deny).toContain("edit_file");
    expect(deny).toContain("delete_file");
  });

  test("report.requiredSections covers the leaf envelope", () => {
    const sections = explorePackage.report.requiredSections;
    expect(sections).toContain("Summary");
    expect(sections).toContain("Findings");
    expect(sections).toContain("Blockers");
    expect(sections).toContain("Paths");
  });

  test("modelRole is explore", () => {
    expect(explorePackage.modelRole).toBe("explore");
  });
});
