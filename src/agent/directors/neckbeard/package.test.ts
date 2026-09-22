import { describe, expect, test } from "bun:test";
import { neckbeardPackage } from "./package.js";

describe("neckbeardPackage", () => {
  test("systemPrompt is a substantial near-literal port", () => {
    // gaas neckbeard.md is ~504 lines; Corbits adaptations still keep a long prompt.
    expect(neckbeardPackage.systemPrompt.length).toBeGreaterThan(8_000);
  });

  test("systemPrompt names NeckbeardDirector and never-fix stance", () => {
    expect(neckbeardPackage.systemPrompt).toMatch(/NeckbeardDirector/);
    expect(neckbeardPackage.systemPrompt).toMatch(/never fix/i);
    expect(neckbeardPackage.systemPrompt).toContain("builder (to fix)");
    expect(neckbeardPackage.systemPrompt).toContain("Critic");
    expect(neckbeardPackage.systemPrompt).not.toMatch(/Critique/);
  });

  test("systemPrompt keeps comic voice without emoji glyphs", () => {
    const p = neckbeardPackage.systemPrompt;
    expect(p).toMatch(/Actually,/);
    expect(p).toMatch(/Well technically,/);
    expect(p).toMatch(/Have you considered Rust/);
    expect(p).toMatch(/Utterly Unbearable Mode/);
    expect(p).toMatch(/Peak Neckbeard/);
    // AGENTS.md: no emoji glyphs in code/docs strings
    expect(p).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    expect(p).not.toMatch(/[\u2600-\u27BF]/u);
  });

  test("systemPrompt maps Corbits docs paths and code review", () => {
    const p = neckbeardPackage.systemPrompt;
    expect(p).toContain("docs/PRODUCT.md");
    expect(p).toContain("docs/ARCHITECTURE.md");
    expect(p).toContain("docs/IMPLEMENTATION.md");
    expect(p).toMatch(/code \(when the brief asks\)|code review/i);
  });

  test("systemPrompt treats style/philosophy as attached and reports to parent", () => {
    const p = neckbeardPackage.systemPrompt;
    expect(p).toContain("Style and philosophy are attached");
    expect(p).toContain("Do not use_skill them again");
    expect(p).toContain("DO NOT park waiting for a skill load");
    expect(p).not.toMatch(/Load the `style` and `philosophy` conventions/);
    expect(p).not.toMatch(
      /DO NOT DO ANYTHING ELSE BEFORE YOU'VE DONE ALL STEPS/,
    );
    expect(p).not.toMatch(/use_skill.*not mounted|not mounted.*use_skill/i);
    expect(p).toMatch(/violently disagree/i);
    expect(p).toMatch(/report to the parent/i);
    expect(p).toMatch(/Corbits report envelope/);
    expect(p).not.toMatch(/## Summary/);
    expect(p).not.toMatch(/## Findings/);
    expect(p).not.toMatch(/## Blockers/);
    expect(p).not.toMatch(/## Paths/);
    expect(p).toMatch(/ranked nits with evidence|evidence paths/i);
  });

  test("tools.allow mounts read", () => {
    const allow = neckbeardPackage.tools?.allow ?? [];
    expect(allow).toContain("read_file");
  });

  test("modelRole is review", () => {
    expect(neckbeardPackage.modelRole).toBe("review");
  });

  test("attachedSkills are style and philosophy; optionalSkills are on-demand", () => {
    expect(neckbeardPackage.attachedSkills).toEqual(["style", "philosophy"]);
    expect(neckbeardPackage.optionalSkills).toEqual(["native-integration"]);
  });

  test("primaryIntent and outOfLane match neckbeard lane", () => {
    expect(neckbeardPackage.primaryIntent).toBe(
      "Adversarial pedantic review; never fix",
    );
    expect(neckbeardPackage.outOfLane).toContain("applying fixes");
    expect(neckbeardPackage.outOfLane).toContain("product implementation");
    expect(neckbeardPackage.outOfLane).toContain("architecture ownership");
  });
});
