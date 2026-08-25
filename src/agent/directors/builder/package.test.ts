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
    expect(p).toMatch(/implementer leaf/i);
    expect(p).not.toMatch(/build director/i);
  });

  test("systemPrompt teaches implement-and-test from the implement skill", () => {
    const p = builderPackage.systemPrompt;
    expect(p).toContain("Implement and Test");
    expect(p).toContain("success_criteria");
    expect(p).toMatch(/bug fixes \(test-first\)/i);
    expect(p).toMatch(/reproduces the bug/i);
    expect(p).toMatch(/verify it \*\*fails\*\*/);
    expect(p).toMatch(/For new features/i);
    expect(p).toMatch(/assert.*expected behavior|works as designed/i);
    expect(p).toContain("Blockers");
  });

  test("systemPrompt teaches Build Gate and does not shortcut verify", () => {
    const p = builderPackage.systemPrompt;
    expect(p).toContain("Build Gate");
    expect(p).toMatch(/bun run check/);
    expect(p).toMatch(/Don't shortcut verify/i);
    expect(p).toMatch(/partial gates/i);
    expect(p).toMatch(/pre-existing/i);
  });

  test("systemPrompt requires style and philosophy prerequisites", () => {
    const p = builderPackage.systemPrompt;
    expect(p).toContain("Prerequisites");
    expect(p).toMatch(/style and philosophy/i);
    expect(p).toMatch(/use_skill is not mounted/i);
  });

  test("systemPrompt is implement leaf only (no orchestrate / spawn / review-as-primary)", () => {
    const p = builderPackage.systemPrompt;
    expect(p).toMatch(/Do not spawn specialists/i);
    expect(p).toMatch(/maySpawn:false/);
    expect(p).toMatch(/not Critic/i);
    expect(p).toMatch(/not Explorer/i);
    expect(p).toMatch(/not an orchestrator/i);
    expect(p).toMatch(/@greybeard/i);
    expect(p).toMatch(/@critique/i);
    expect(p).toMatch(/report Blockers for the parent/i);
    expect(p).not.toMatch(/Spawn the @critique/i);
    expect(p).not.toMatch(/Use the @greybeard subagent/i);
  });

  test("systemPrompt prefers working tree over committing unless brief requires it", () => {
    const p = builderPackage.systemPrompt;
    expect(p).toMatch(/does NOT commit unless/i);
    expect(p).toMatch(/working tree \+ report/i);
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
    expect(prompt).toMatch(/build gate/i);
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
