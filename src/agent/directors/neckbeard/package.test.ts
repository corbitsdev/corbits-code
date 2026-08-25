import { describe, expect, test } from "bun:test";
import { neckbeardPackage } from "./package.js";

describe("neckbeardPackage", () => {
  test("id matches directory", () => {
    expect(neckbeardPackage.id).toBe("neckbeard");
  });

  test("systemPrompt is real (not Placeholder)", () => {
    expect(neckbeardPackage.systemPrompt.length).toBeGreaterThan(0);
    expect(neckbeardPackage.systemPrompt.startsWith("Placeholder")).toBe(false);
  });

  test("systemPrompt is a substantial near-literal port", () => {
    // gaas neckbeard.md is ~504 lines; Corbits adaptations still keep a long prompt.
    expect(neckbeardPackage.systemPrompt.length).toBeGreaterThan(8_000);
  });

  test("systemPrompt states PRIMARY INTENT", () => {
    expect(neckbeardPackage.systemPrompt).toMatch(/PRIMARY INTENT/i);
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

  test("systemPrompt bakes style/philosophy and reports to parent", () => {
    const p = neckbeardPackage.systemPrompt;
    expect(p).toMatch(/use_skill.*not mounted|not mounted.*use_skill/i);
    expect(p).toMatch(/violently disagree/);
    expect(p).toMatch(/report to the parent/i);
    expect(p).toMatch(/## Summary/);
    expect(p).toMatch(/## Findings/);
    expect(p).toMatch(/## Blockers/);
    expect(p).toMatch(/## Paths/);
    expect(p).toMatch(/ranked nits with evidence|evidence paths/i);
  });

  test("spawn.maySpawn is false", () => {
    expect(neckbeardPackage.spawn.maySpawn).toBe(false);
  });

  test("mounts product write tools", () => {
    const allow = neckbeardPackage.tools?.allow ?? [];
    expect(allow).toContain("read_file");
    expect(allow).toContain("write_file");
    expect(allow).toContain("edit_file");
    expect(allow).toContain("delete_file");
  });

  test("modelRole is review", () => {
    expect(neckbeardPackage.modelRole).toBe("review");
  });

  test("optionalSkills are style and philosophy", () => {
    expect(neckbeardPackage.optionalSkills).toEqual(["style", "philosophy"]);
  });

  test("primaryIntent and outOfLane match neckbeard lane", () => {
    expect(neckbeardPackage.primaryIntent).toBe("Adversarial pedantic review; never fix");
    expect(neckbeardPackage.outOfLane).toContain("applying fixes");
    expect(neckbeardPackage.outOfLane).toContain("product implementation");
    expect(neckbeardPackage.outOfLane).toContain("architecture ownership");
  });
});
