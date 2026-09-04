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

  test("systemPrompt identity is Critic / CriticDirector", () => {
    const p = criticPackage.systemPrompt;
    expect(p).toMatch(/CriticDirector \(Critic\)/);
    expect(p).toMatch(/review lane only/i);
    expect(p).not.toMatch(/CritiqueDirector/);
  });

  test("systemPrompt is evidence-based defects, never-fix", () => {
    const p = criticPackage.systemPrompt;
    expect(p).toMatch(/evidence-based/i);
    expect(p).toMatch(/defects with evidence/i);
    expect(p).toMatch(/never fix/i);
    expect(p).toMatch(/permanent tests/i);
    expect(p).toContain("testsmith/builder");
    expect(p).toContain("route to builder");
  });

  test("systemPrompt has blinders-on / brief-scoped review", () => {
    const p = criticPackage.systemPrompt;
    expect(p).toMatch(/BLINDERS ON/i);
    expect(p).toMatch(/success_criteria/i);
    expect(p).toMatch(/Do not wander/i);
    expect(p).toMatch(/invent defects from vibes/i);
  });

  test("systemPrompt is correctness plus this-diff hygiene", () => {
    const p = criticPackage.systemPrompt;
    expect(p).toMatch(/Correctness and this-diff hygiene/i);
    expect(p).toMatch(/correctness or the stated requirements\/success_criteria/i);
    expect(p).toMatch(/hygiene this diff introduced/i);
    expect(p).toMatch(/dead code/i);
    expect(p).toMatch(/file-for-later/i);
    expect(p).toMatch(/Do not drive over-engineering/i);
    expect(p).toMatch(/impossible cases/i);
    expect(p).not.toMatch(/correctness-only/i);
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
    expect(criticPackage.systemPrompt).toMatch(/parameter order\/optionality\/return-type drift/i);
    expect(criticPackage.systemPrompt).toMatch(/Rank these as blocking, not style nits/i);
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

  test("spawn.maySpawn is false", () => {
    expect(criticPackage.spawn.maySpawn).toBe(false);
  });

  test("tools.allow is review surface with product writes", () => {
    const allow = criticPackage.tools?.allow ?? [];
    expect(allow).toContain("read_file");
    expect(allow).not.toContain("use_skill");
    expect(allow).toContain("write_file");
    expect(allow).toContain("edit_file");
    expect(allow).toContain("delete_file");
  });

  test("modelRole is review", () => {
    expect(criticPackage.modelRole).toBe("review");
  });

  test("optionalSkills order is style, philosophy, idiot-proof", () => {
    expect(criticPackage.optionalSkills).toEqual(["style", "philosophy", "idiot-proof"]);
  });

  test("primaryIntent and outOfLane match critic lane", () => {
    expect(criticPackage.primaryIntent).toBe(
      "Evidence-based code review including hygiene the diff introduced; never fix product code",
    );
    expect(criticPackage.outOfLane).toContain("implementing fixes");
    expect(criticPackage.outOfLane).toContain("architecture portfolio without code evidence");
    expect(criticPackage.outOfLane).toContain("visual brand");
    expect(criticPackage.outOfLane).toContain("DESIGN.md");
    expect(criticPackage.outOfLane).toContain("pedantic fun without evidence");
  });
});
