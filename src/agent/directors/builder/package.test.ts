import { describe, expect, test } from "bun:test";
import { builderPackage } from "./package.js";

describe("builderPackage", () => {
  test("id matches directory / registry id", () => {
    expect(builderPackage.id).toBe("builder");
  });

  test("systemPrompt is non-empty and not a Placeholder", () => {
    expect(builderPackage.systemPrompt.length).toBeGreaterThan(0);
    expect(builderPackage.systemPrompt.startsWith("Placeholder")).toBe(false);
  });

  test("systemPrompt mentions PRIMARY INTENT", () => {
    expect(builderPackage.systemPrompt).toContain("PRIMARY INTENT");
  });

  test("spawn.maySpawn is false (leaf)", () => {
    expect(builderPackage.spawn.maySpawn).toBe(false);
  });

  test("tools.allow includes product write tools", () => {
    const allow = builderPackage.tools?.allow ?? [];
    expect(allow).toContain("write_file");
    expect(allow).toContain("edit_file");
    expect(allow).toContain("delete_file");
    expect(allow).toContain("apply_patch");
  });

  test("modelRole is implement", () => {
    expect(builderPackage.modelRole).toBe("implement");
  });

  test("optionalSkills order is style, philosophy, typescript", () => {
    expect(builderPackage.optionalSkills).toEqual(["style", "philosophy", "typescript"]);
  });

  test("systemPrompt has DONE GATE for success_criteria", () => {
    const prompt = builderPackage.systemPrompt;
    expect(prompt).toContain("DONE GATE");
    expect(prompt).toContain("success_criteria");
    expect(prompt).toMatch(/[Ss]top when/);
  });

  test("systemPrompt has VERIFY language", () => {
    const prompt = builderPackage.systemPrompt;
    expect(prompt).toContain("VERIFY");
    expect(prompt).toMatch(/typecheck|tests/);
    expect(prompt).toContain("Blockers");
  });

  test("systemPrompt has REPORT MAP for criteria and Paths", () => {
    const prompt = builderPackage.systemPrompt;
    expect(prompt).toContain("REPORT MAP");
    expect(prompt).toMatch(/success_criteria.*pass|fail|blocked/s);
    expect(prompt).toMatch(/Paths must list files touched/);
  });

  test("systemPrompt has API CONTRACT for sync/async preservation", () => {
    const prompt = builderPackage.systemPrompt;
    expect(prompt).toContain("API CONTRACT");
    expect(prompt).toMatch(/sync/i);
    expect(prompt).toMatch(/Promise|async/);
    expect(prompt).toMatch(/public API|return shape/i);
  });
});
