import { describe, expect, test } from "bun:test";
import { gauntletPackage } from "./package.js";

describe("gauntletPackage", () => {
  test("id matches directory / registry id", () => {
    expect(gauntletPackage.id).toBe("gauntlet");
  });

  test("systemPrompt is non-empty and not a Placeholder", () => {
    expect(gauntletPackage.systemPrompt.length).toBeGreaterThan(0);
    expect(gauntletPackage.systemPrompt.startsWith("Placeholder")).toBe(false);
  });

  test("systemPrompt identity is Gauntlet / GauntletDirector", () => {
    const p = gauntletPackage.systemPrompt;
    expect(p).toMatch(/GauntletDirector \(Gauntlet\)/);
    expect(p).toContain("PRIMARY INTENT");
    expect(p).toMatch(/mutation\/vacuity lane/i);
  });

  test("systemPrompt states the mutation-check lane (break, fail, restore, pass)", () => {
    const p = gauntletPackage.systemPrompt;
    expect(p).toMatch(/mutation-check that tests can actually fail/i);
    expect(p).toMatch(/breaking mutation/i);
    expect(p).toMatch(/must FAIL/);
    expect(p).toMatch(/must PASS/);
    expect(p).toMatch(/byte-identical/);
    expect(p).toMatch(/tree clean/);
  });

  test("systemPrompt never leaves a breaking edit in the tree", () => {
    const p = gauntletPackage.systemPrompt;
    expect(p).toMatch(/never leave a breaking edit in the tree/i);
    expect(p).toMatch(/git status/);
    expect(p).toMatch(/git diff/);
  });

  test("systemPrompt names the vacuous-test verdict", () => {
    const p = gauntletPackage.systemPrompt;
    expect(p).toMatch(/vacuous/);
    expect(p).toMatch(/passes under mutation/i);
  });

  test("systemPrompt does not replace tester or testsmith", () => {
    const p = gauntletPackage.systemPrompt;
    expect(p).toMatch(/not Tester, not Testsmith/i);
    expect(p).toMatch(/do not replace tester/i);
    expect(p).toMatch(/route to tester/);
    expect(p).toMatch(/route to[\s\S]*testsmith/i);
  });

  test("systemPrompt states Corbits report shape and done gate", () => {
    const p = gauntletPackage.systemPrompt;
    expect(p).toContain("## Summary");
    expect(p).toContain("## Findings");
    expect(p).toContain("## Blockers");
    expect(p).toContain("## Paths");
    expect(p).toMatch(/DONE GATE/i);
    expect(p).toMatch(/BLINDERS ON/i);
    expect(p).toContain("success_criteria");
  });

  test("systemPrompt has no tool-schema restatement or fake caps", () => {
    const p = gauntletPackage.systemPrompt;
    expect(p).not.toMatch(/parameters?:/i);
    expect(p).not.toMatch(/fan-out/i);
    expect(p).not.toMatch(/at most \d+/i);
    expect(p).not.toMatch(/turn budget/i);
    expect(p).not.toMatch(/scheduler/i);
  });

  test("spawn.maySpawn is false (leaf)", () => {
    expect(gauntletPackage.spawn.maySpawn).toBe(false);
  });

  test("tier is leaf", () => {
    expect(gauntletPackage.tier).toBe("leaf");
  });

  test("tools.allow mounts the review surface (lane discipline in prompt)", () => {
    const allow = gauntletPackage.tools?.allow ?? [];
    expect(allow).toContain("read_file");
    expect(allow).toContain("run_shell");
    expect(allow).toContain("write_file");
    expect(allow).toContain("edit_file");
    expect(allow).toContain("delete_file");
  });

  test("modelRole is test", () => {
    expect(gauntletPackage.modelRole).toBe("test");
  });

  test("primaryIntent and outOfLane match the gauntlet lane", () => {
    expect(gauntletPackage.primaryIntent).toMatch(/mutation-check/i);
    expect(gauntletPackage.primaryIntent).toMatch(
      /never leave a breaking edit/i,
    );
    const joined = gauntletPackage.outOfLane.join(" ");
    expect(joined).toMatch(/shipping product code/i);
    expect(joined).toMatch(/designing test cases/i);
    expect(joined).toMatch(/full suite as a pass\/fail gate/i);
  });
});
