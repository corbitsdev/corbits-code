import { describe, expect, test } from "bun:test";
import { draperPackage } from "./package.js";

describe("draperPackage", () => {
  test("id matches directory", () => {
    expect(draperPackage.id).toBe("draper");
  });

  test("systemPrompt is real, not a placeholder", () => {
    expect(draperPackage.systemPrompt.length).toBeGreaterThan(0);
    expect(draperPackage.systemPrompt.startsWith("Placeholder")).toBe(false);
  });

  test("systemPrompt states PRIMARY INTENT", () => {
    expect(draperPackage.systemPrompt).toMatch(/PRIMARY INTENT/i);
  });

  test("systemPrompt identity is Draper / DraperDirector (package id stays draper)", () => {
    const p = draperPackage.systemPrompt;
    expect(p).toMatch(/DraperDirector \(Draper\)/);
    expect(p).toMatch(/full critique lane/i);
    expect(p).not.toMatch(/Brand Reviewer/);
    expect(p).not.toMatch(/brand-reviewer/);
  });

  test("systemPrompt covers any artifact — visual, written, interactive", () => {
    const p = draperPackage.systemPrompt;
    expect(p).toMatch(/visual, written, or interactive/i);
    expect(p).toMatch(/CBS \(Corbits Brand System\)/i);
    expect(p).toMatch(/You find\. You never fix/i);
  });

  test("systemPrompt carries all five restored lenses", () => {
    const p = draperPackage.systemPrompt;
    expect(p).toMatch(/Visual identity/i);
    expect(p).toMatch(/Written identity/i);
    expect(p).toMatch(/Messaging integrity/i);
    expect(p).toMatch(/Interactive quality/i);
    expect(p).toMatch(/Brand coherence/i);
    expect(p).toMatch(/No lens → speculation/i);
  });

  test("systemPrompt restores the written-identity copy gates", () => {
    const p = draperPackage.systemPrompt;
    expect(p).toMatch(/hype language/i);
    expect(p).toMatch(/supercharge/);
    expect(p).toMatch(/anthropomorphiz/i);
    expect(p).toMatch(/Faremeter is independent/i);
    expect(p).toMatch(/voice blending/i);
    expect(p).toMatch(/Oxford commas?/i);
    expect(p).toMatch(/passive voice/i);
  });

  test("systemPrompt restores the messaging-integrity gates", () => {
    const p = draperPackage.systemPrompt;
    expect(p).toMatch(/five pillars/i);
    expect(p).toMatch(/dogfooding/);
    expect(p).toMatch(/elevator pitch/i);
    expect(p).toMatch(/one-liners/i);
    expect(p).toMatch(/features instead of outcomes/i);
    expect(p).toMatch(/Interchange is the product/i);
  });

  test("systemPrompt keeps the interactive and coherence gates", () => {
    const p = draperPackage.systemPrompt;
    expect(p).toMatch(/0\.97/);
    expect(p).toMatch(/30-80ms/);
    expect(p).toMatch(/40px/);
    expect(p).toMatch(/Canvas Cream/i);
    expect(p).toMatch(/inverts instead of adapts/i);
  });

  test("systemPrompt gates never-create / never-suggest / never-modify", () => {
    const p = draperPackage.systemPrompt;
    expect(p).toMatch(/Do not create content/i);
    expect(p).toMatch(/suggest specific wording/i);
    expect(p).toMatch(/Do not .* redesign/i);
    expect(p).toMatch(/modify production code or assets/i);
    expect(p).toMatch(/improvise brand values/i);
    expect(p).toContain("Builder (fixes)");
    expect(p).toContain("Rand (DESIGN.md ownership)");
    expect(p).toContain("Emil (design-engineering laws)");
  });

  test("systemPrompt keeps verdict scale and confidence discipline", () => {
    const p = draperPackage.systemPrompt;
    expect(p).toMatch(
      /COMPLIANT \/ MINOR DEVIATIONS \/ MAJOR DEVIATIONS \/ NON-COMPLIANT/,
    );
    expect(p).toMatch(/VERIFIED.*HIGH.*MEDIUM/);
    expect(p).toMatch(/Discard LOW/i);
    expect(p).toMatch(/expected value, and the actual value/i);
    expect(p).toMatch(/Cross-domain issues/i);
  });

  test("systemPrompt keeps evidence-test workflow with cleanup rule", () => {
    const p = draperPackage.systemPrompt;
    expect(p).toMatch(/Evidence tests/i);
    expect(p).toMatch(/Clean up temporary checks/i);
    expect(p).toMatch(/permanent/);
  });

  test("systemPrompt stays brief-scoped, no invented brand values", () => {
    const p = draperPackage.systemPrompt;
    expect(p).toMatch(/BLINDERS ON/i);
    expect(p).toMatch(/success_criteria/i);
    expect(p).toMatch(/Do not wander/i);
    expect(p).toMatch(/if the reference does not specify it, say so/i);
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

  test("spawn.maySpawn is false", () => {
    expect(draperPackage.spawn.maySpawn).toBe(false);
  });

  test("tools.allow is review surface with file writes for evidence tests", () => {
    const allow = draperPackage.tools?.allow ?? [];
    expect(allow).toContain("read_file");
    expect(allow).not.toContain("use_skill");
    expect(allow).toContain("write_file");
    expect(allow).toContain("edit_file");
    expect(allow).toContain("delete_file");
  });

  test("modelRole is review and tier is leaf", () => {
    expect(draperPackage.modelRole).toBe("review");
    expect(draperPackage.tier).toBe("leaf");
  });

  test("primaryIntent and outOfLane match the restored full-critique lane", () => {
    expect(draperPackage.primaryIntent).toMatch(/Brand and design critique/i);
    expect(draperPackage.primaryIntent).toMatch(/never fix/i);
    expect(draperPackage.outOfLane).toContain("shipping product code");
    expect(draperPackage.outOfLane).toContain(
      "creating content or suggesting copy wording",
    );
    expect(draperPackage.outOfLane).toContain("redesigning artifacts");
    expect(draperPackage.outOfLane).toContain(
      "modifying production code or assets",
    );
    expect(draperPackage.outOfLane).not.toContain("marketing copy pipeline");
  });
});
