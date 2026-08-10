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

  test("systemPrompt has finish bias against re-reading the same paths", () => {
    expect(explorePackage.systemPrompt).toMatch(/FINISH BIAS/i);
    expect(explorePackage.systemPrompt).toMatch(/re-reading the same paths/i);
    expect(explorePackage.systemPrompt).toMatch(
      /Expand Findings, change approach, or write the final report/i,
    );
  });

  test("systemPrompt requires scannable Findings shape", () => {
    expect(explorePackage.systemPrompt).toMatch(/FINDINGS SHAPE/i);
    expect(explorePackage.systemPrompt).toMatch(/scannable map/i);
    expect(explorePackage.systemPrompt).toMatch(/key paths/i);
    expect(explorePackage.systemPrompt).toMatch(/symbols/i);
    expect(explorePackage.systemPrompt).toMatch(/call flow/i);
  });

  test("systemPrompt notes maxTurns budget is real", () => {
    expect(explorePackage.systemPrompt).toMatch(/maxTurns/i);
    expect(explorePackage.systemPrompt).toMatch(/wrap up before thrash/i);
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
