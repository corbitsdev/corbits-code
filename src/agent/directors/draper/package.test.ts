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
    expect(p).toMatch(/visual\/CBS review lane only/i);
  });

  test("systemPrompt is visual/CBS critique, never-fix", () => {
    const p = draperPackage.systemPrompt;
    expect(p).toMatch(/CBS \(Corbits Brand System\)/i);
    expect(p).toMatch(/visual and CBS/i);
    expect(p).toMatch(/Never fix product code/i);
    expect(p).toMatch(/Never redesign or rewrite copy/i);
    expect(p).toContain("build (fixes)");
    expect(p).toContain("brand-reviewer (DESIGN.md ownership)");
    expect(p).toContain("emil (design-engineering laws)");
  });

  test("systemPrompt has blinders-on / brief-scoped visual review", () => {
    const p = draperPackage.systemPrompt;
    expect(p).toMatch(/BLINDERS ON/i);
    expect(p).toMatch(/success_criteria/i);
    expect(p).toMatch(/Do not wander/i);
    expect(p).toMatch(/invent brand issues from vibes/i);
  });

  test("systemPrompt keeps CBS lenses and evidence discipline", () => {
    const p = draperPackage.systemPrompt;
    expect(p).toMatch(/Visual identity/i);
    expect(p).toMatch(/Interactive quality/i);
    expect(p).toMatch(/Component craft/i);
    expect(p).toMatch(/Brand coherence/i);
    expect(p).toMatch(/cites? at least one (lens|per finding)/i);
    expect(p).toMatch(/expected vs actual/i);
    expect(p).toMatch(/VERIFIED \/ HIGH \/ MEDIUM/i);
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

  test("tools.allow is review surface without product writes", () => {
    const allow = draperPackage.tools?.allow ?? [];
    expect(allow).toContain("read_file");
    expect(allow).not.toContain("use_skill");
    expect(allow).not.toContain("write_file");
    expect(allow).not.toContain("edit_file");
    expect(allow).not.toContain("delete_file");
  });

  test("modelRole is review", () => {
    expect(draperPackage.modelRole).toBe("review");
  });

  test("primaryIntent and outOfLane match draper lane", () => {
    expect(draperPackage.primaryIntent).toBe(
      "Product visual/CBS critique from a development perspective",
    );
    expect(draperPackage.outOfLane).toContain("shipping product code");
    expect(draperPackage.outOfLane).toContain("marketing copy pipeline");
    expect(draperPackage.outOfLane).toContain("rewriting copy or redesigning");
    expect(draperPackage.outOfLane).toContain("applying product fixes");
  });
});
