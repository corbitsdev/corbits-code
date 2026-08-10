import { describe, expect, test } from "bun:test";
import { implementPackage } from "./package.js";

describe("implementPackage", () => {
  test("id matches directory / registry id", () => {
    expect(implementPackage.id).toBe("implement");
  });

  test("systemPrompt is non-empty and not a Placeholder", () => {
    expect(implementPackage.systemPrompt.length).toBeGreaterThan(0);
    expect(implementPackage.systemPrompt.startsWith("Placeholder")).toBe(false);
  });

  test("systemPrompt mentions PRIMARY INTENT", () => {
    expect(implementPackage.systemPrompt).toContain("PRIMARY INTENT");
  });

  test("spawn.maySpawn is false (leaf)", () => {
    expect(implementPackage.spawn.maySpawn).toBe(false);
  });

  test("tools.allow includes product write tools", () => {
    const allow = implementPackage.tools?.allow ?? [];
    expect(allow).toContain("write_file");
    expect(allow).toContain("edit_file");
    expect(allow).toContain("delete_file");
  });

  test("report.requiredSections includes Summary, Findings, Blockers, Paths", () => {
    const sections = implementPackage.report.requiredSections;
    expect(sections).toContain("Summary");
    expect(sections).toContain("Findings");
    expect(sections).toContain("Blockers");
    expect(sections).toContain("Paths");
  });

  test("modelRole is implement", () => {
    expect(implementPackage.modelRole).toBe("implement");
  });

  test("optionalSkills order is style, philosophy, typescript", () => {
    expect(implementPackage.optionalSkills).toEqual(["style", "philosophy", "typescript"]);
  });
});
