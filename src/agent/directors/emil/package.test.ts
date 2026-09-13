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

  test("systemPrompt identity is Emil / EmilDirector (package id stays emil)", () => {
    const p = emilPackage.systemPrompt;
    expect(p).toMatch(/EmilDirector \(Emil\)/);
    expect(p).toMatch(/design-eng critique lane only/i);
  });

  test("systemPrompt states PRIMARY INTENT", () => {
    expect(emilPackage.systemPrompt).toMatch(/PRIMARY INTENT/i);
    expect(emilPackage.systemPrompt).toContain("route to builder");
  });

  test("systemPrompt is design-eng critique, never-fix", () => {
    const p = emilPackage.systemPrompt;
    expect(p).toMatch(/design-engineering critique/i);
    expect(p).toMatch(/never fix/i);
    expect(p).toMatch(/cite at least one per finding/i);
    expect(p).toMatch(/Design-engineering craft/i);
    expect(p).toMatch(/Animate with purpose/i);
    expect(p).toMatch(/Easing & speed/i);
    expect(p).toContain("route to draper");
    expect(p).toContain("route to rand");
    expect(p).toContain("route to critic");
    expect(p).not.toMatch(/brand-reviewer/);
    expect(p).not.toMatch(/route to critique\b/);
  });

  test("systemPrompt covers product decisions, not just code", () => {
    const p = emilPackage.systemPrompt;
    expect(p).toMatch(/product decisions/i);
    expect(p).toMatch(
      /critical eye that finds problems through principles and evidence/i,
    );
  });

  test("systemPrompt has blinders-on / brief-scoped design-eng review", () => {
    const p = emilPackage.systemPrompt;
    expect(p).toMatch(/BLINDERS ON/i);
    expect(p).toMatch(/success_criteria/i);
    expect(p).toMatch(/Do not wander/i);
    expect(p).toMatch(/invent law\s+violations from vibes/i);
  });

  test("systemPrompt keeps classic software laws as secondary lenses", () => {
    const p = emilPackage.systemPrompt;
    expect(p).toMatch(/YAGNI/);
    expect(p).toMatch(/Principle of Least Astonishment/);
    expect(p).toMatch(/Broken Windows/);
    expect(p).toMatch(/No implementation prescriptions/i);
  });

  test("systemPrompt restores the Thinking & Reasoning laws (CL-7801)", () => {
    const p = emilPackage.systemPrompt;
    expect(p).toMatch(/Thinking & reasoning/i);
    expect(p).toMatch(/First Principles/);
    expect(p).toMatch(/Inversion/);
    expect(p).toMatch(/Map Is Not the Territory/);
    expect(p).toMatch(/Gilb's Law/);
  });

  test("systemPrompt restores the Boy Scout Rule (CL-7801)", () => {
    expect(emilPackage.systemPrompt).toMatch(/Boy Scout Rule/);
  });

  test("systemPrompt restores the reviewer capabilities incl. temp tests (CL-7801)", () => {
    const p = emilPackage.systemPrompt;
    expect(p).toMatch(/tmp\/critique-tests/);
    expect(p).toMatch(/Run existing test suites/i);
    expect(p).toMatch(/linter|type checker|static analysis/i);
    expect(p).toMatch(
      /If a test disproves your hypothesis, discard that finding/i,
    );
  });

  test("systemPrompt restores the design-eng cross-reference checklist (CL-7801)", () => {
    const p = emilPackage.systemPrompt;
    expect(p).toMatch(/cross-reference/i);
    expect(p).toMatch(/missing will-change/i);
    expect(p).toMatch(/scale-on-press values/i);
    expect(p).toMatch(/hit area minimums/i);
  });

  test("systemPrompt defers to the scaffold envelope and carries report content as Findings sub-bullets (CL-7801)", () => {
    const p = emilPackage.systemPrompt;
    expect(p).toMatch(/# Report\n/);
    expect(p).toMatch(/scaffold owns its shape/i);
    expect(p).not.toMatch(/# Report format/);
    expect(p).not.toMatch(/## Summary/);
    expect(p).not.toMatch(/## Findings/);
    expect(p).not.toMatch(/## Test results/);
    expect(p).not.toMatch(/## Observations/);
    expect(p).not.toMatch(/## Blockers/);
    expect(p).not.toMatch(/## Paths/);
    expect(p).toMatch(/Recommended tests for permanent inclusion/i);
    expect(p).toMatch(/confidence.*VERIFIED \/ HIGH \/ MEDIUM/i);
    expect(p).toMatch(/severity.*Critical.*Major.*Minor/i);
    expect(p).toMatch(/Observations: patterns across findings/);
  });

  test("systemPrompt restores guidelines and negative constraints (CL-7801)", () => {
    const p = emilPackage.systemPrompt;
    expect(p).toMatch(/Quality Over Quantity/i);
    expect(p).toMatch(/Cite the Law/i);
    expect(p).toMatch(/Evidence Required/i);
    expect(p).toMatch(/Severity Matters/i);
    expect(p).toMatch(/Don't Moralize/i);
    expect(p).toMatch(/Do not modify production code/i);
    expect(p).toMatch(/Do not commit changes/i);
    expect(p).toMatch(/Do not write permanent test files/i);
  });

  test("systemPrompt has no tool-schema restatement or fake caps", () => {
    const p = emilPackage.systemPrompt;
    expect(p).not.toMatch(/parameters?:/i);
    expect(p).not.toMatch(/fan-out/i);
    expect(p).not.toMatch(/at most \d+/i);
    expect(p).not.toMatch(/turn budget/i);
    expect(p).not.toMatch(/scheduler/i);
    expect(p).not.toMatch(/Prefer grep\/search_files/i);
    expect(p).not.toMatch(/Shell find\/rg/i);
    expect(p).not.toMatch(/Write tools are not mounted/i);
    expect(p).not.toMatch(/via run_shell/i);
    expect(p).not.toMatch(/Never spawn/);
  });

  test("spawn.maySpawn is false", () => {
    expect(emilPackage.spawn.maySpawn).toBe(false);
  });

  test("tools.allow is review surface with product writes", () => {
    const allow = emilPackage.tools?.allow ?? [];
    expect(allow).toContain("read_file");
    expect(allow).not.toContain("use_skill");
    expect(allow).toContain("write_file");
    expect(allow).toContain("edit_file");
    expect(allow).toContain("delete_file");
  });

  test("modelRole is review", () => {
    expect(emilPackage.modelRole).toBe("review");
  });

  test("description matches the CMO original (CL-7801)", () => {
    expect(emilPackage.description).toMatch(/Design engineering critique/i);
    expect(emilPackage.description).toMatch(/product decisions/i);
    expect(emilPackage.description).toMatch(/never fixes them/i);
  });

  test("primaryIntent and outOfLane match emil lane", () => {
    expect(emilPackage.primaryIntent).toBe(
      "Design-engineering laws review; never fix product code",
    );
    expect(emilPackage.outOfLane).toContain(
      "shipping product code without design brief",
    );
    expect(emilPackage.outOfLane).toContain("marketing content");
    expect(emilPackage.outOfLane).toContain("applying product fixes");
    expect(emilPackage.outOfLane).toContain(
      "suggesting full rewrites as implementer",
    );
    expect(emilPackage.outOfLane).toContain(
      "CBS visual token ownership (draper)",
    );
    expect(emilPackage.outOfLane).toContain("DESIGN.md ownership (rand)");
    expect(emilPackage.outOfLane).toContain(
      "correctness-severity ownership (critic)",
    );
  });
});
