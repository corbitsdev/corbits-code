import { describe, expect, test } from "bun:test";
import { critiquePackage } from "./package.js";

describe("critiquePackage", () => {
  test("id matches directory", () => {
    expect(critiquePackage.id).toBe("critique");
  });

  test("systemPrompt is real, not a placeholder", () => {
    expect(critiquePackage.systemPrompt.length).toBeGreaterThan(0);
    expect(critiquePackage.systemPrompt.startsWith("Placeholder")).toBe(false);
  });

  test("systemPrompt states PRIMARY INTENT", () => {
    expect(critiquePackage.systemPrompt).toMatch(/PRIMARY INTENT/i);
  });

  test("systemPrompt is evidence-based and never-fix", () => {
    expect(critiquePackage.systemPrompt).toMatch(/evidence-based/i);
    expect(critiquePackage.systemPrompt).toMatch(/never fix/i);
    expect(critiquePackage.systemPrompt).toMatch(/permanent tests/i);
    expect(critiquePackage.systemPrompt).toContain("testsmith/build");
    expect(critiquePackage.systemPrompt).toContain("route to build");
  });

  test("systemPrompt is correctness-only / anti-over-engineering", () => {
    expect(critiquePackage.systemPrompt).toMatch(/correctness-only/i);
    expect(critiquePackage.systemPrompt).toMatch(/anti-over-engineering/i);
    expect(critiquePackage.systemPrompt).toMatch(
      /correctness or the stated requirements\/success_criteria/i,
    );
    expect(critiquePackage.systemPrompt).toMatch(/style nits/i);
    expect(critiquePackage.systemPrompt).toMatch(/file-for-later/i);
    expect(critiquePackage.systemPrompt).toMatch(/Do not drive over-engineering/i);
    expect(critiquePackage.systemPrompt).toMatch(/impossible cases/i);
  });

  test("systemPrompt flags API contract / sync→async as blocking", () => {
    expect(critiquePackage.systemPrompt).toMatch(/API contract check/i);
    expect(critiquePackage.systemPrompt).toMatch(/blocking when brief specifies signatures/i);
    expect(critiquePackage.systemPrompt).toMatch(/public exports/i);
    expect(critiquePackage.systemPrompt).toMatch(/Sync\s*→\s*async/i);
    expect(critiquePackage.systemPrompt).toMatch(
      /returning Promise when callers expect a plain value/i,
    );
    expect(critiquePackage.systemPrompt).toMatch(/blocking correctness defect/i);
    expect(critiquePackage.systemPrompt).toMatch(
      /parameter order\/optionality\/return-type drift/i,
    );
    expect(critiquePackage.systemPrompt).toMatch(/Rank these as blocking, not style nits/i);
  });

  test("spawn.maySpawn is false", () => {
    expect(critiquePackage.spawn.maySpawn).toBe(false);
  });

  test("tools.allow is review surface without product writes", () => {
    const allow = critiquePackage.tools?.allow ?? [];
    expect(allow).toContain("read_file");
    expect(allow).toContain("read_file");
    expect(allow).not.toContain("use_skill");
    expect(allow).not.toContain("write_file");
    expect(allow).not.toContain("edit_file");
    expect(allow).not.toContain("delete_file");
  });

  test("modelRole is review", () => {
    expect(critiquePackage.modelRole).toBe("review");
  });

  test("optionalSkills order is style, philosophy", () => {
    expect(critiquePackage.optionalSkills).toEqual(["style", "philosophy"]);
  });

  test("primaryIntent and outOfLane match critique lane", () => {
    expect(critiquePackage.primaryIntent).toBe(
      "Evidence-based code review; never fix product code",
    );
    expect(critiquePackage.outOfLane).toContain("implementing fixes");
    expect(critiquePackage.outOfLane).toContain("architecture portfolio without code evidence");
    expect(critiquePackage.outOfLane).toContain("visual brand");
    expect(critiquePackage.outOfLane).toContain("DESIGN.md");
    expect(critiquePackage.outOfLane).toContain("pedantic fun without evidence");
  });
});
