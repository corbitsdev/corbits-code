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

  test("systemPrompt identity is Builder / BuilderDirector (not job-title language)", () => {
    const p = builderPackage.systemPrompt;
    expect(p).toMatch(/BuilderDirector \(Builder\)/);
    expect(p).toMatch(/implement lane only/i);
    expect(p).not.toMatch(/build director/i);
  });

  test("systemPrompt teaches success_criteria-driven shipping", () => {
    const p = builderPackage.systemPrompt;
    expect(p).toContain("Ship against the brief");
    expect(p).toContain("success_criteria");
    expect(p).toMatch(/minimum required files/i);
    expect(p).toMatch(/focused checks/i);
    expect(p).toMatch(/changed paths/i);
    expect(p).toContain("Blockers");
  });

  test("systemPrompt is implement lane only (no orchestrate / spawn / review-as-primary)", () => {
    const p = builderPackage.systemPrompt;
    expect(p).toMatch(/Do not spawn specialists/i);
    expect(p).toMatch(/not Critic/i);
    expect(p).toMatch(/not Explorer/i);
    expect(p).toMatch(/not an orchestrator/i);
    expect(p).toMatch(/ambiguous/i);
    expect(p).toMatch(/report Blockers/i);
    expect(p).toMatch(/greybeard/i);
    expect(p).toMatch(/counsel/i);
  });

  test("systemPrompt has no tool-schema restatement or fake caps", () => {
    const p = builderPackage.systemPrompt;
    expect(p).not.toMatch(/parameters?:/i);
    expect(p).not.toMatch(/fan-out/i);
    expect(p).not.toMatch(/at most \d+/i);
    expect(p).not.toMatch(/turn budget/i);
    expect(p).not.toMatch(/scheduler/i);
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
