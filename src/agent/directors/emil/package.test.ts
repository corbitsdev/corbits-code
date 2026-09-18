import { describe, expect, test } from "bun:test";
import { emilPackage } from "./package.js";

describe("emilPackage", () => {
  test("systemPrompt identity is Emil / EmilDirector (package id stays emil)", () => {
    const p = emilPackage.systemPrompt;
    expect(p).toMatch(/EmilDirector \(Emil\)/);
    expect(p).toMatch(/design-eng critique lane only/i);
  });

  test("systemPrompt is design-eng critique with fix direction, never full fixes", () => {
    const p = emilPackage.systemPrompt;
    expect(p).toMatch(/design-engineering critique with fix direction/i);
    expect(p).toMatch(/You do not fix anything/i);
    expect(p).toMatch(/Fix direction/);
    expect(p).toMatch(/not a full implementation/i);
    expect(p).toMatch(/You do not write production fixes/i);
    expect(p).not.toMatch(/No implementation prescriptions/i);
    expect(p).not.toMatch(/brand-reviewer/);
    expect(p).not.toMatch(/route to critique\b/);
  });

  test("systemPrompt uses brand-identity for visual tokens only", () => {
    const p = emilPackage.systemPrompt;
    expect(p).toMatch(/Use brand-identity only for visual tokens/i);
    expect(p).toMatch(/visual-token compliance when relevant/i);
    expect(p).toMatch(/own visual tokens \(route to draper\)/i);
  });

  test("systemPrompt carries the eight upstream craft principles", () => {
    const p = emilPackage.systemPrompt;
    expect(p).toMatch(/Purposeful motion/);
    expect(p).toMatch(/Frequency-aware motion/);
    expect(p).toMatch(/Responsive feedback/);
    expect(p).toMatch(/Calm hierarchy/);
    expect(p).toMatch(/Surface discipline/);
    expect(p).toMatch(/Direct labels/);
    expect(p).toMatch(/Accessible defaults/);
    expect(p).toMatch(/Implementation restraint/);
  });

  test("systemPrompt keeps only the seven-law lens set", () => {
    const p = emilPackage.systemPrompt;
    expect(p).toMatch(/Cite at least one per finding/);
    expect(p).toMatch(/KISS/);
    expect(p).toMatch(/YAGNI/);
    expect(p).toMatch(/DRY/);
    expect(p).toMatch(/Law of Demeter/);
    expect(p).toMatch(/Premature Optimization/);
    expect(p).toMatch(/Broken Windows/);
    expect(p).toMatch(/Map Is Not the Territory/);
  });

  test("systemPrompt carries no retired law library", () => {
    const p = emilPackage.systemPrompt;
    expect(p).not.toMatch(/Second-System/);
    expect(p).not.toMatch(/Zawinski/);
    expect(p).not.toMatch(/SOLID/);
    expect(p).not.toMatch(/Boy Scout Rule/);
    expect(p).not.toMatch(/First Principles/);
    expect(p).not.toMatch(/Inversion/);
    expect(p).not.toMatch(/Gilb's Law/);
    expect(p).not.toMatch(/Principle of Least Astonishment/);
    expect(p).not.toMatch(/Testing Pyramid/);
    expect(p).not.toMatch(/Pesticide Paradox/);
    expect(p).not.toMatch(/Sturgeon/);
    expect(p).not.toMatch(/Technical Debt/);
    expect(p).not.toMatch(/Postel/);
    expect(p).not.toMatch(/Thinking & reasoning/i);
    expect(p).not.toMatch(/cross-reference/i);
    expect(p).not.toMatch(/tmp\/critique-tests/);
    expect(p).not.toMatch(/Quality Over Quantity/);
    expect(p).not.toMatch(/Don't Moralize/);
  });

  test("systemPrompt evaluates against the repo DESIGN.md; creation routes to rand", () => {
    const p = emilPackage.systemPrompt;
    expect(p).toMatch(/repo's own DESIGN\.md/);
    expect(p).toMatch(/load DESIGN\.md as the design contract/i);
    expect(p).toMatch(/do not create it yourself/i);
    expect(p).toMatch(/route creation to rand/i);
    expect(p).toMatch(/never silent writes/i);
    expect(p).toMatch(/stated minimal default/i);
    expect(p).toMatch(/cap those findings at MEDIUM/i);
  });

  test("systemPrompt covers product decisions, not just code", () => {
    const p = emilPackage.systemPrompt;
    expect(p).toMatch(/product decisions/i);
    expect(p).toMatch(/critical eye, not the hand that solves/i);
  });

  test("systemPrompt has blinders-on / brief-scoped design-eng review", () => {
    const p = emilPackage.systemPrompt;
    expect(p).toMatch(/BLINDERS ON/i);
    expect(p).toMatch(/success_criteria/i);
    expect(p).toMatch(/Do not wander/i);
    expect(p).toMatch(/invent violations from vibes/i);
  });

  test("systemPrompt keeps the upstream verdict scale and confidence discipline", () => {
    const p = emilPackage.systemPrompt;
    expect(p).toMatch(
      /Approved \/ Approved with notes \/ Changes requested \/ Reject/,
    );
    expect(p).toMatch(
      /Findings come before praise unless the artifact is approved/i,
    );
    expect(p).toMatch(/VERIFIED, HIGH, or MEDIUM/);
    expect(p).toMatch(/Drop low-confidence observations/i);
    expect(p).toMatch(/Why it matters/);
  });

  test("systemPrompt defers to the scaffold envelope and carries report content as Findings", () => {
    const p = emilPackage.systemPrompt;
    expect(p).toMatch(/scaffold owns the envelope shape/i);
    expect(p).toMatch(/numbered findings/);
    expect(p).toMatch(/what works \(only if useful\)/i);
    expect(p).not.toMatch(/## Summary/);
    expect(p).not.toMatch(/## Findings/);
    expect(p).not.toMatch(/## Blockers/);
    expect(p).not.toMatch(/## Paths/);
  });

  test("systemPrompt keeps negative constraints without prescribing temp tests", () => {
    const p = emilPackage.systemPrompt;
    expect(p).toMatch(/fix bugs or write production code/i);
    expect(p).toMatch(/commit changes/i);
    expect(p).toMatch(/write test files of any kind \(route to builder\)/i);
    expect(p).toMatch(/Run existing checks only when useful/i);
    expect(p).toContain("route to builder");
    expect(p).toContain("route to draper");
    expect(p).toContain("route to rand");
    expect(p).toContain("route to critic");
    expect(p).toContain("route to greybeard");
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

  test("tools.allow is read-only: no product writes", () => {
    const allow = emilPackage.tools?.allow ?? [];
    expect(allow).toContain("read_file");
    expect(allow).toContain("run_shell");
    expect(allow).toContain("skill_search");
    expect(allow).toContain("use_skill");
    expect(allow).not.toContain("write_file");
    expect(allow).not.toContain("edit_file");
    expect(allow).not.toContain("delete_file");
  });

  test("optionalSkills declares brand-identity only", () => {
    expect(emilPackage.optionalSkills).toEqual(["brand-identity"]);
  });

  test("modelRole is review", () => {
    expect(emilPackage.modelRole).toBe("review");
  });

  test("description matches the narrowed tokens-only lane", () => {
    expect(emilPackage.description).toMatch(/Design engineering critique/i);
    expect(emilPackage.description).toMatch(/product decisions/i);
    expect(emilPackage.description).toMatch(/fix direction/i);
    expect(emilPackage.description).toMatch(/never fixes them/i);
  });

  test("primaryIntent and outOfLane match emil lane", () => {
    expect(emilPackage.primaryIntent).toBe(
      "Design-engineering critique with fix direction; never fix product code",
    );
    expect(emilPackage.outOfLane).toContain("shipping product code");
    expect(emilPackage.outOfLane).toContain("marketing content");
    expect(emilPackage.outOfLane).toContain(
      "applying product fixes or writing full implementations",
    );
    expect(emilPackage.outOfLane).toContain("visual-token ownership (draper)");
    expect(emilPackage.outOfLane).toContain("DESIGN.md ownership (rand)");
    expect(emilPackage.outOfLane).toContain(
      "correctness-severity ownership (critic)",
    );
    expect(emilPackage.outOfLane).toContain("architecture gate (greybeard)");
  });
});
