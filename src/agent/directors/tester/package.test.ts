import { describe, expect, test } from "bun:test";
import { testerPackage } from "./package.js";

describe("testerPackage", () => {
  test("id matches directory / registry id", () => {
    expect(testerPackage.id).toBe("tester");
  });

  test("systemPrompt is non-empty and not a Placeholder", () => {
    expect(testerPackage.systemPrompt.length).toBeGreaterThan(0);
    expect(testerPackage.systemPrompt.startsWith("Placeholder")).toBe(false);
  });

  test("systemPrompt states PRIMARY INTENT to verify not fix", () => {
    expect(testerPackage.systemPrompt).toContain("PRIMARY INTENT");
    expect(testerPackage.systemPrompt).toMatch(/run|verify/i);
    expect(testerPackage.systemPrompt).toMatch(/never fix|do not.*fix|Never fix/i);
    expect(testerPackage.systemPrompt).toContain("re-dispatch to build or testsmith");
  });

  test("spawn.maySpawn is false (leaf)", () => {
    expect(testerPackage.spawn.maySpawn).toBe(false);
  });

  test("tools.allow is read-only (no product writes)", () => {
    const allow = testerPackage.tools?.allow ?? [];
    expect(allow).toContain("run_shell");
    expect(allow).toContain("read_file");
    expect(allow).not.toContain("write_file");
    expect(allow).not.toContain("edit_file");
    expect(allow).not.toContain("delete_file");
  });

  test("report.requiredSections includes Summary, Findings, Blockers, Paths", () => {
    const sections = testerPackage.report.requiredSections;
    expect(sections).toContain("Summary");
    expect(sections).toContain("Findings");
    expect(sections).toContain("Blockers");
    expect(sections).toContain("Paths");
  });

  test("modelRole is test", () => {
    expect(testerPackage.modelRole).toBe("test");
  });

  test("nudge.maxTurns is 40", () => {
    expect(testerPackage.nudge?.maxTurns).toBe(40);
  });

  test("primaryIntent is runtime verify never fix", () => {
    expect(testerPackage.primaryIntent).toMatch(/run|verify/i);
    expect(testerPackage.primaryIntent).toMatch(/never fix/i);
  });
});
