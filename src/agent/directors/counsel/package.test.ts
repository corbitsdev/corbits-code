import { describe, expect, test } from "bun:test";
import { counselPackage } from "./package.js";

describe("counselPackage", () => {
  test("id matches directory", () => {
    expect(counselPackage.id).toBe("counsel");
  });

  test("systemPrompt is real (not Placeholder)", () => {
    expect(counselPackage.systemPrompt.length).toBeGreaterThan(0);
    expect(counselPackage.systemPrompt.startsWith("Placeholder")).toBe(false);
  });

  test("systemPrompt states PRIMARY INTENT", () => {
    expect(counselPackage.systemPrompt).toMatch(/PRIMARY INTENT/i);
  });

  test("systemPrompt identity is Counsel / CounselDirector (not PlanDirector)", () => {
    const p = counselPackage.systemPrompt;
    expect(p).toMatch(/CounselDirector \(Counsel\)/);
    expect(p).toMatch(/plan lane only/i);
    expect(p).not.toMatch(/PlanDirector/);
    expect(p).not.toMatch(/You are Plan\b/);
  });

  test("systemPrompt teaches ordered eng plans with no ship", () => {
    const p = counselPackage.systemPrompt;
    expect(p).toMatch(/ordered engineering change plans/i);
    expect(p).toMatch(/agent-proof plan/i);
    expect(p).toMatch(/acceptance criteria/i);
    expect(p).toMatch(/Non-goals/i);
    expect(p).toMatch(/Ordered steps/i);
    expect(p).toMatch(/Do not implement product code/i);
    expect(p).toMatch(/Do not ship the change yourself/i);
  });

  test("systemPrompt is blinders-on plan lane (no orchestrate / ship / review-as-primary)", () => {
    const p = counselPackage.systemPrompt;
    expect(p).toMatch(/Blinders on/i);
    expect(p).toMatch(/Do not spawn specialists/i);
    expect(p).toMatch(/not Builder/i);
    expect(p).toMatch(/not Critic/i);
    expect(p).toMatch(/not Explorer/i);
    expect(p).toMatch(/not an orchestrator/i);
    expect(p).toMatch(/Greybeard/i);
  });

  test("systemPrompt has no tool-schema restatement or fake caps", () => {
    const p = counselPackage.systemPrompt;
    expect(p).not.toMatch(/parameters?:/i);
    expect(p).not.toMatch(/fan-out/i);
    expect(p).not.toMatch(/at most \d+/i);
    expect(p).not.toMatch(/turn budget/i);
    expect(p).not.toMatch(/scheduler/i);
  });

  test("systemPrompt has DONE GATE for plan completeness", () => {
    const p = counselPackage.systemPrompt;
    expect(p).toContain("DONE GATE");
    expect(p).toContain("success_criteria");
    expect(p).toMatch(/[Ss]top when/);
    expect(p).toContain("Blockers");
  });

  test("spawn.maySpawn is false", () => {
    expect(counselPackage.spawn.maySpawn).toBe(false);
  });

  test("tools.allow is review surface with product writes", () => {
    const allow = counselPackage.tools?.allow ?? [];
    expect(allow).toContain("read_file");
    expect(allow).toContain("write_file");
    expect(allow).toContain("edit_file");
    expect(allow).toContain("delete_file");
  });

  test("modelRole is plan", () => {
    expect(counselPackage.modelRole).toBe("plan");
  });

  test("optionalSkills order", () => {
    expect(counselPackage.optionalSkills).toEqual(["style", "philosophy"]);
  });

  test("does not advertise interview skill workers cannot use", () => {
    expect(counselPackage.optionalSkills).not.toContain("interview");
    expect(counselPackage.systemPrompt).not.toMatch(/interview-skill awareness/i);
  });

  test("primaryIntent and outOfLane match counsel / plan lane", () => {
    expect(counselPackage.primaryIntent).toBe("Author ordered eng change plans; do not implement");
    expect(counselPackage.description).toMatch(/Counsel/i);
    expect(counselPackage.outOfLane).toContain("shipping code");
    expect(counselPackage.outOfLane).toContain("architecture gate sign-off as Greybeard");
    expect(counselPackage.outOfLane).toContain("running the fleet");
    expect(counselPackage.outOfLane).toContain("pure code review");
    expect(counselPackage.outOfLane).toContain("becoming Builder or Critic");
  });
});
