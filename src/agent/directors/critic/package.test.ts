import { describe, expect, test } from "bun:test";
import { criticPackage } from "./package.js";

describe("criticPackage", () => {
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
    expect(p).toMatch(
      /correctness or the stated requirements\/success_criteria/i,
    );
    expect(p).toMatch(/hygiene this diff introduced/i);
    expect(p).toMatch(/dead code/i);
    expect(p).toMatch(/file-for-later/i);
    expect(p).toMatch(/Do not drive over-engineering/i);
    expect(p).toMatch(/impossible cases/i);
    expect(p).not.toMatch(/correctness-only/i);
  });

  test("systemPrompt flags API contract / sync→async as blocking", () => {
    expect(criticPackage.systemPrompt).toMatch(/API contract check/i);
    expect(criticPackage.systemPrompt).toMatch(
      /blocking when brief specifies signatures/i,
    );
    expect(criticPackage.systemPrompt).toMatch(/public exports/i);
    expect(criticPackage.systemPrompt).toMatch(/Sync\s*→\s*async/i);
    expect(criticPackage.systemPrompt).toMatch(
      /returning Promise when callers expect a plain value/i,
    );
    expect(criticPackage.systemPrompt).toMatch(/blocking correctness defect/i);
    expect(criticPackage.systemPrompt).toMatch(
      /parameter order\/optionality\/return-type drift/i,
    );
    expect(criticPackage.systemPrompt).toMatch(
      /Rank these as blocking, not style nits/i,
    );
  });

  test("systemPrompt restores verify-by-temporary-test workflow", () => {
    const p = criticPackage.systemPrompt;
    expect(p).toMatch(/Verify by temporary test/i);
    expect(p).toMatch(/Form hypotheses/i);
    expect(p).toContain("tmp/critique-tests/");
    expect(p).toMatch(/report only verified issues/i);
    expect(p).toMatch(/keepers for permanent inclusion/i);
    expect(p).toMatch(/clean up/i);
  });

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

  test("systemPrompt treats style and philosophy as attached, not boot loads", () => {
    const p = criticPackage.systemPrompt;
    expect(p).toContain("Session Initialization");
    expect(p).toContain("style and philosophy are attached");
    expect(p).toContain("Do not use_skill them again");
    expect(p).toContain("Do not block boot if an attached skill is missing");
    expect(p).toContain("native-integration and idiot-proof remain on-demand");
    expect(p).not.toContain("Load the style skill with use_skill");
    expect(p).not.toContain(
      "Do not do anything else before you have done all steps above",
    );
    expect(p.indexOf("Session Initialization")).toBeLessThan(
      p.indexOf("PRIMARY INTENT"),
    );
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

  test("systemPrompt labels VERIFIED/HIGH/MEDIUM and refuses LOW findings", () => {
    const p = criticPackage.systemPrompt;
    expect(p).toContain(
      "Confidence level: VERIFIED (proven by tests), HIGH (strong evidence but not testable), MEDIUM (plausible but uncertain)",
    );
    expect(p).toContain("Do not report LOW confidence findings");
    expect(p).toContain("Do not report speculative concerns");
    expect(p).toMatch(/never conflated/);
  });

  test("systemPrompt discards low-confidence noise directly", () => {
    const p = criticPackage.systemPrompt;
    expect(p).toContain(
      "Only report VERIFIED, HIGH, or MEDIUM findings. Do not waste time with unverified speculation. Discard low-confidence findings",
    );
  });

  test("systemPrompt hunts keepers and routes to testsmith/builder without committing", () => {
    const p = criticPackage.systemPrompt;
    expect(p).toContain(
      "Actively look for opportunities to recommend tests for permanent inclusion",
    );
    expect(p).toContain("route keepers to testsmith/builder");
    expect(p).toContain("never commit them from here");
  });
});
