import { describe, expect, test } from "bun:test";
import { draperPackage } from "./package.js";

describe("draperPackage", () => {
  test("systemPrompt has zero hardcoded Faremeter/Corbits gates", () => {
    const p = draperPackage.systemPrompt;
    expect(p).not.toMatch(/Faremeter/);
    expect(p).not.toMatch(/Canvas Cream/);
    expect(p).not.toMatch(/Oxford commas?/i);
    expect(p).not.toMatch(/five pillars/i);
    expect(p).not.toMatch(/dogfooding/i);
    expect(p).not.toMatch(/Interchange/);
    expect(p).not.toMatch(/CBS/);
    expect(p).not.toMatch(/Messaging integrity/);
    expect(p).not.toMatch(/Interactive quality/);
    expect(p).not.toMatch(/Brand coherence/);
    expect(p).not.toMatch(/hype language/i);
    expect(p).not.toMatch(/supercharge/);
    expect(p).not.toMatch(/elevator pitch/i);
    expect(p).not.toMatch(/one-liners/i);
    expect(p).not.toMatch(/0\.97/);
    expect(p).not.toMatch(/passive voice/i);
  });

  test("systemPrompt has no tool-schema restatement or fake caps", () => {
    const p = draperPackage.systemPrompt;
    expect(p).not.toMatch(/parameters?:/i);
    expect(p).not.toMatch(/fan-out/i);
    expect(p).not.toMatch(/at most \d+/i);
    expect(p).not.toMatch(/turn budget/i);
    expect(p).not.toMatch(/scheduler/i);
    expect(p).not.toMatch(/Prefer grep\/search_files/i);
    expect(p).not.toMatch(/Shell find\/rg/i);
    expect(p).not.toMatch(/Write tools are not mounted/i);
    expect(p).not.toMatch(/via run_shell/i);
    expect(p).not.toMatch(/Never commit/i);
    expect(p).not.toMatch(/## Summary/);
    expect(p).not.toMatch(/## Findings/);
    expect(p).not.toMatch(/## Blockers/);
    expect(p).not.toMatch(/## Paths/);
  });

  test("tools.allow is read-only: no product writes", () => {
    const allow = draperPackage.tools?.allow ?? [];
    expect(allow).toContain("read_file");
    expect(allow).toContain("skill_search");
    expect(allow).toContain("use_skill");
    expect(allow).not.toContain("write_file");
    expect(allow).not.toContain("edit_file");
    expect(allow).not.toContain("delete_file");
  });

  test("optionalSkills declares the two router skills", () => {
    expect(draperPackage.optionalSkills).toContain("brand-identity");
    expect(draperPackage.optionalSkills).toContain("brand-review");
  });

  test("modelRole is review", () => {
    expect(draperPackage.modelRole).toBe("review");
  });

  test("primaryIntent and outOfLane match the router lane", () => {
    expect(draperPackage.primaryIntent).toMatch(/Brand critique router/i);
    expect(draperPackage.primaryIntent).toMatch(/never fix/i);
    expect(draperPackage.outOfLane).toContain("shipping product code");
    expect(draperPackage.outOfLane).toContain(
      "creating content or suggesting copy wording",
    );
    expect(draperPackage.outOfLane).toContain("redesigning artifacts");
    expect(draperPackage.outOfLane).toContain(
      "modifying production code or assets",
    );
    expect(draperPackage.outOfLane).toContain("publishing content");
  });
});
