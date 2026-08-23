import { describe, expect, test } from "bun:test";
import { buildDirectorPackage } from "./package.js";

describe("buildDirectorPackage", () => {
  test("id matches directory / registry id", () => {
    expect(buildDirectorPackage.id).toBe("build");
  });

  test("systemPrompt is non-empty and not a Placeholder", () => {
    expect(buildDirectorPackage.systemPrompt.length).toBeGreaterThan(0);
    expect(buildDirectorPackage.systemPrompt.startsWith("Placeholder")).toBe(false);
  });

  test("systemPrompt mentions PRIMARY INTENT", () => {
    expect(buildDirectorPackage.systemPrompt).toContain("PRIMARY INTENT");
  });

  test("spawn.maySpawn is false (leaf)", () => {
    expect(buildDirectorPackage.spawn.maySpawn).toBe(false);
  });

  test("tools.allow includes product write tools", () => {
    const allow = buildDirectorPackage.tools?.allow ?? [];
    expect(allow).toContain("write_file");
    expect(allow).toContain("edit_file");
    expect(allow).toContain("delete_file");
    expect(allow).toContain("apply_patch");
  });

  test("report.requiredSections includes Summary, Findings, Blockers, Paths", () => {
    const sections = buildDirectorPackage.report.requiredSections;
    expect(sections).toContain("Summary");
    expect(sections).toContain("Findings");
    expect(sections).toContain("Blockers");
    expect(sections).toContain("Paths");
  });

  test("modelRole is implement", () => {
    expect(buildDirectorPackage.modelRole).toBe("implement");
  });

  test("optionalSkills order is style, philosophy, typescript", () => {
    expect(buildDirectorPackage.optionalSkills).toEqual(["style", "philosophy", "typescript"]);
  });

  test("systemPrompt has DONE GATE for success_criteria", () => {
    const prompt = buildDirectorPackage.systemPrompt;
    expect(prompt).toContain("DONE GATE");
    expect(prompt).toContain("success_criteria");
    expect(prompt).toMatch(/[Ss]top when/);
  });

  test("systemPrompt has VERIFY language", () => {
    const prompt = buildDirectorPackage.systemPrompt;
    expect(prompt).toContain("VERIFY");
    expect(prompt).toMatch(/typecheck|tests/);
    expect(prompt).toContain("Blockers");
  });

  test("systemPrompt has REPORT MAP for criteria and Paths", () => {
    const prompt = buildDirectorPackage.systemPrompt;
    expect(prompt).toContain("REPORT MAP");
    expect(prompt).toMatch(/success_criteria.*pass|fail|blocked/s);
    expect(prompt).toMatch(/Paths must list files touched/);
  });

  test("systemPrompt has API CONTRACT for sync/async preservation", () => {
    const prompt = buildDirectorPackage.systemPrompt;
    expect(prompt).toContain("API CONTRACT");
    expect(prompt).toMatch(/sync/i);
    expect(prompt).toMatch(/Promise|async/);
    expect(prompt).toMatch(/public API|return shape/i);
  });
});
