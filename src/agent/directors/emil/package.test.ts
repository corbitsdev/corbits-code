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
    expect(p).toMatch(/design-eng laws lane only/i);
  });

  test("systemPrompt states PRIMARY INTENT", () => {
    expect(emilPackage.systemPrompt).toMatch(/PRIMARY INTENT/i);
    expect(emilPackage.systemPrompt).toContain("route to builder");
  });

  test("systemPrompt is design-eng laws review, never-fix", () => {
    const p = emilPackage.systemPrompt;
    expect(p).toMatch(/design-engineering laws review/i);
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

  test("systemPrompt has blinders-on / brief-scoped design-eng review", () => {
    const p = emilPackage.systemPrompt;
    expect(p).toMatch(/BLINDERS ON/i);
    expect(p).toMatch(/success_criteria/i);
    expect(p).toMatch(/Do not wander/i);
    expect(p).toMatch(/invent law violations from vibes/i);
  });

  test("systemPrompt keeps classic software laws as secondary lenses", () => {
    const p = emilPackage.systemPrompt;
    expect(p).toMatch(/YAGNI/);
    expect(p).toMatch(/Principle of Least Astonishment/);
    expect(p).toMatch(/Broken Windows/);
    expect(p).toMatch(/No implementation prescriptions/i);
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
    expect(p).not.toMatch(/not temp test files/i);
    expect(p).not.toMatch(/# Report shape/);
    expect(p).not.toMatch(/## Summary/);
    expect(p).not.toMatch(/Never spawn/);
    expect(p).not.toMatch(/Never commit/);
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

  test("primaryIntent and outOfLane match emil lane", () => {
    expect(emilPackage.primaryIntent).toBe(
      "Design-engineering laws review; never fix product code",
    );
    expect(emilPackage.outOfLane).toContain("shipping product code without design brief");
    expect(emilPackage.outOfLane).toContain("marketing content");
    expect(emilPackage.outOfLane).toContain("applying product fixes");
    expect(emilPackage.outOfLane).toContain("suggesting full rewrites as implementer");
    expect(emilPackage.outOfLane).toContain("CBS visual token ownership (draper)");
    expect(emilPackage.outOfLane).toContain("DESIGN.md ownership (rand)");
    expect(emilPackage.outOfLane).toContain("correctness-severity ownership (critic)");
  });
});
