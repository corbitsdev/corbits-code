import { describe, expect, test } from "bun:test";
import { criticPackage } from "./package.js";

describe("criticPackage", () => {
  test("id matches directory", () => {
    expect(criticPackage.id).toBe("critic");
  });

  test("systemPrompt is real, not a placeholder", () => {
    expect(criticPackage.systemPrompt.length).toBeGreaterThan(0);
    expect(criticPackage.systemPrompt.startsWith("Placeholder")).toBe(false);
  });

  test("systemPrompt states PRIMARY INTENT", () => {
    expect(criticPackage.systemPrompt).toMatch(/PRIMARY INTENT/i);
  });

  test("systemPrompt is evidence-based and never-fix", () => {
    expect(criticPackage.systemPrompt).toMatch(/evidence-based/i);
    expect(criticPackage.systemPrompt).toMatch(/never fix/i);
    expect(criticPackage.systemPrompt).toMatch(/permanent tests/i);
    expect(criticPackage.systemPrompt).toContain("testsmith/builder");
    expect(criticPackage.systemPrompt).toContain("route to builder");
  });

  test("systemPrompt is correctness-only / anti-over-engineering", () => {
    expect(criticPackage.systemPrompt).toMatch(/correctness-only/i);
    expect(criticPackage.systemPrompt).toMatch(/anti-over-engineering/i);
    expect(criticPackage.systemPrompt).toMatch(
      /correctness or the stated requirements\/success_criteria/i,
    );
    expect(criticPackage.systemPrompt).toMatch(/style nits/i);
    expect(criticPackage.systemPrompt).toMatch(/file-for-later/i);
    expect(criticPackage.systemPrompt).toMatch(/Do not drive over-engineering/i);
    expect(criticPackage.systemPrompt).toMatch(/impossible cases/i);
  });

  test("systemPrompt flags API contract / sync→async as blocking", () => {
    expect(criticPackage.systemPrompt).toMatch(/API contract check/i);
    expect(criticPackage.systemPrompt).toMatch(/blocking when brief specifies signatures/i);
    expect(criticPackage.systemPrompt).toMatch(/public exports/i);
    expect(criticPackage.systemPrompt).toMatch(/Sync\s*→\s*async/i);
    expect(criticPackage.systemPrompt).toMatch(
      /returning Promise when callers expect a plain value/i,
    );
    expect(criticPackage.systemPrompt).toMatch(/blocking correctness defect/i);
    expect(criticPackage.systemPrompt).toMatch(
      /parameter order\/optionality\/return-type drift/i,
    );
    expect(criticPackage.systemPrompt).toMatch(/Rank these as blocking, not style nits/i);
  });

  test("spawn.maySpawn is false", () => {
    expect(criticPackage.spawn.maySpawn).toBe(false);
  });

  test("tools.allow is review surface with product writes", () => {
    const allow = criticPackage.tools?.allow ?? [];
    expect(allow).toContain("read_file");
    expect(allow).toContain("read_file");
    expect(allow).not.toContain("use_skill");
    expect(allow).toContain("write_file");
    expect(allow).toContain("edit_file");
    expect(allow).toContain("delete_file");
  });

  test("modelRole is review", () => {
    expect(criticPackage.modelRole).toBe("review");
  });

  test("optionalSkills order is style, philosophy", () => {
    expect(criticPackage.optionalSkills).toEqual(["style", "philosophy"]);
  });

  test("primaryIntent and outOfLane match critique lane", () => {
    expect(criticPackage.primaryIntent).toBe(
      "Evidence-based code review; never fix product code",
    );
    expect(criticPackage.outOfLane).toContain("implementing fixes");
    expect(criticPackage.outOfLane).toContain("architecture portfolio without code evidence");
    expect(criticPackage.outOfLane).toContain("visual brand");
    expect(criticPackage.outOfLane).toContain("DESIGN.md");
    expect(criticPackage.outOfLane).toContain("pedantic fun without evidence");
  });
});
