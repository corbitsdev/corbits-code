import { describe, expect, test } from "bun:test";
import { draperPackage } from "./package.js";

describe("draperPackage", () => {
  test("systemPrompt identity is Draper / DraperDirector (package id stays draper)", () => {
    const p = draperPackage.systemPrompt;
    expect(p).toMatch(/DraperDirector \(Draper\)/);
    expect(p).toMatch(/brand critique router/i);
    expect(p).not.toMatch(/Brand Reviewer/);
    expect(p).not.toMatch(/brand-reviewer/);
  });

  test("systemPrompt routes the three upstream layers, never audits from memory", () => {
    const p = draperPackage.systemPrompt;
    expect(p).toMatch(/brand-identity is the visual layer/i);
    expect(p).toMatch(/brand-review is the copy\/messaging layer/i);
    expect(p).toMatch(/interface craft routes to Emil/i);
    expect(p).toMatch(/Do not recreate the old full-reference brand audit/i);
    expect(p).toMatch(/Load the relevant skills only/i);
  });

  test("systemPrompt carries the visual-identity lens", () => {
    const p = draperPackage.systemPrompt;
    expect(p).toMatch(/Visual identity/i);
    expect(p).toMatch(
      /load brand-identity when the artifact has a visual layer/i,
    );
    expect(p).toMatch(/logo misuse/i);
    expect(p).toMatch(/No lens → speculation/i);
  });

  test("systemPrompt carries the brand-review lens", () => {
    const p = draperPackage.systemPrompt;
    expect(p).toMatch(/Brand review/i);
    expect(p).toMatch(/load brand-review when the artifact includes copy/i);
    expect(p).toMatch(/Generic AI\/startup language/i);
    expect(p).toMatch(/unsupported claims/i);
    expect(p).toMatch(/anthropomorphize behavior/i);
  });

  test("systemPrompt routes interface craft to Emil", () => {
    const p = draperPackage.systemPrompt;
    expect(p).toMatch(/Interface craft/i);
    expect(p).toMatch(/suggest Emil parallel review/i);
    expect(p).toMatch(/decorative animation without purpose/i);
    expect(p).toMatch(/look branded but feel careless/i);
  });

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

  test("systemPrompt evaluates against the repo DESIGN.md; creation routes to rand", () => {
    const p = draperPackage.systemPrompt;
    expect(p).toMatch(/repo's own DESIGN\.md/);
    expect(p).toMatch(/DESIGN\.md is the artifact's design contract/i);
    expect(p).toMatch(/do not create it yourself/i);
    expect(p).toMatch(/route creation to rand/i);
    expect(p).toMatch(/never silent writes/i);
    expect(p).toMatch(/stated minimal default/i);
    expect(p).toMatch(/cap those findings at MEDIUM/i);
  });

  test("systemPrompt keeps the upstream verdict scale and findings-first order", () => {
    const p = draperPackage.systemPrompt;
    expect(p).toMatch(/Approved with notes/);
    expect(p).toMatch(/Changes requested/);
    expect(p).toMatch(/\bReject\b/);
    expect(p).toMatch(
      /Findings come before praise unless the artifact is approved/i,
    );
    expect(p).toMatch(/Why it matters/);
    expect(p).toMatch(/Fix direction or reviewer follow-up/);
    expect(p).toMatch(/suggested parallel review/i);
  });

  test("systemPrompt gates never-fix / never-create / never-publish", () => {
    const p = draperPackage.systemPrompt;
    expect(p).toMatch(/You find\. You never fix/i);
    expect(p).toMatch(/Do not ship fixes/i);
    expect(p).toMatch(/Do not create content/i);
    expect(p).toMatch(/redesign artifacts/i);
    expect(p).toMatch(/modify production code or assets/i);
    expect(p).toMatch(/improvise brand values/i);
    expect(p).toContain("Builder (fixes)");
    expect(p).toContain("Rand (DESIGN.md ownership)");
    expect(p).toContain("Emil (interface-craft depth)");
  });

  test("systemPrompt stays brief-scoped, no invented brand values", () => {
    const p = draperPackage.systemPrompt;
    expect(p).toMatch(/BLINDERS ON/i);
    expect(p).toMatch(/success_criteria/i);
    expect(p).toMatch(/Do not wander/i);
    expect(p).toMatch(/if the reference does not specify it, say so/i);
  });

  test("systemPrompt defers to the scaffold envelope, no re-specified headings", () => {
    const p = draperPackage.systemPrompt;
    expect(p).toMatch(/scaffold owns the envelope shape/i);
    expect(p).not.toMatch(/## Summary/);
    expect(p).not.toMatch(/## Findings/);
    expect(p).not.toMatch(/## Blockers/);
    expect(p).not.toMatch(/## Paths/);
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
