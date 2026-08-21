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

  test("systemPrompt is a one-pass map, not a re-read loop", () => {
    expect(explorePackage.systemPrompt).toMatch(/scannable map/i);
    expect(explorePackage.systemPrompt).toMatch(/Do not keep re-reading/i);
    expect(explorePackage.systemPrompt).toMatch(/Do not edit/i);
  });

  test("spawn.maySpawn is false", () => {
    expect(explorePackage.spawn.maySpawn).toBe(false);
  });

  test("tools.allow is read-only (no product writes)", () => {
    const allow = explorePackage.tools?.allow ?? [];
    expect(allow).toContain("read_file");
    expect(allow).toContain("grep");
    expect(allow).not.toContain("write_file");
    expect(allow).not.toContain("edit_file");
    expect(allow).not.toContain("delete_file");
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
