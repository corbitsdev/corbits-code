import { describe, expect, test } from "bun:test";
import { criticPackage } from "./package.js";

describe("criticPackage", () => {
  test("systemPrompt owns no report envelope", () => {
    const p = criticPackage.systemPrompt;
    expect(p).not.toMatch(/## Summary/);
    expect(p).not.toMatch(/## Findings/);
    expect(p).not.toMatch(/Recommended Tests for Permanent Inclusion/);
  });

  test("systemPrompt has no tool-schema restatement or fake caps", () => {
    const p = criticPackage.systemPrompt;
    expect(p).not.toMatch(/parameters?:/i);
    expect(p).not.toMatch(/fan-out/i);
    expect(p).not.toMatch(/at most \d+/i);
    expect(p).not.toMatch(/turn budget/i);
    expect(p).not.toMatch(/scheduler/i);
    expect(p).not.toMatch(/Prefer grep\/search_files/i);
    expect(p).not.toMatch(/Shell find\/rg/i);
    expect(p).not.toMatch(/Write tools are not mounted/i);
    expect(p).not.toMatch(/via run_shell/i);
  });

  test("tools.allow mounts read plus skill discovery", () => {
    const allow = criticPackage.tools?.allow ?? [];
    expect(allow).toContain("read_file");
    expect(allow).toContain("skill_search");
    expect(allow).toContain("use_skill");
  });

  test("modelRole is review", () => {
    expect(criticPackage.modelRole).toBe("review");
  });

  test("attachedSkills are style and philosophy; optionalSkills are on-demand", () => {
    expect(criticPackage.attachedSkills).toEqual(["style", "philosophy"]);
    expect(criticPackage.optionalSkills).toEqual([
      "native-integration",
      "idiot-proof",
    ]);
  });

  test("primaryIntent and outOfLane match critic lane", () => {
    expect(criticPackage.primaryIntent).toBe(
      "Evidence-based code review including hygiene the diff introduced; never fix product code",
    );
    expect(criticPackage.outOfLane).toContain("implementing fixes");
    expect(criticPackage.outOfLane).toContain(
      "architecture portfolio without code evidence",
    );
    expect(criticPackage.outOfLane).toContain("visual brand");
    expect(criticPackage.outOfLane).toContain("DESIGN.md");
    expect(criticPackage.outOfLane).toContain("pedantic fun without evidence");
  });
});
