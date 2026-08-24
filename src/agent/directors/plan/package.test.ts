import { describe, expect, test } from "bun:test";
import { planPackage } from "./package.js";

describe("planPackage", () => {
  test("id matches directory (keep plan path; identity is Counsel)", () => {
    expect(planPackage.id).toBe("plan");
  });

  test("systemPrompt is real (not Placeholder)", () => {
    expect(planPackage.systemPrompt.length).toBeGreaterThan(0);
    expect(planPackage.systemPrompt.startsWith("Placeholder")).toBe(false);
  });

  test("systemPrompt states PRIMARY INTENT", () => {
    expect(planPackage.systemPrompt).toMatch(/PRIMARY INTENT/i);
  });

  test("systemPrompt identity is Counsel / CounselDirector (not PlanDirector)", () => {
    const p = planPackage.systemPrompt;
    expect(p).toMatch(/CounselDirector \(Counsel\)/);
    expect(p).toMatch(/plan lane only/i);
    expect(p).not.toMatch(/PlanDirector/);
    expect(p).not.toMatch(/You are Plan\b/);
  });

  test("systemPrompt teaches ordered eng plans with no ship", () => {
    const p = planPackage.systemPrompt;
    expect(p).toMatch(/ordered engineering change plans/i);
    expect(p).toMatch(/agent-proof plan/i);
    expect(p).toMatch(/acceptance criteria/i);
    expect(p).toMatch(/Non-goals/i);
    expect(p).toMatch(/Ordered steps/i);
    expect(p).toMatch(/Do not implement product code/i);
    expect(p).toMatch(/Do not ship the change yourself/i);
  });

  test("systemPrompt is blinders-on plan lane (no orchestrate / ship / review-as-primary)", () => {
    const p = planPackage.systemPrompt;
    expect(p).toMatch(/Blinders on/i);
    expect(p).toMatch(/Do not spawn specialists/i);
    expect(p).toMatch(/not Builder/i);
    expect(p).toMatch(/not Critic/i);
    expect(p).toMatch(/not Explorer/i);
    expect(p).toMatch(/not an orchestrator/i);
    expect(p).toMatch(/Greybeard/i);
  });

  test("systemPrompt has no tool-schema restatement or fake caps", () => {
    const p = planPackage.systemPrompt;
    expect(p).not.toMatch(/parameters?:/i);
    expect(p).not.toMatch(/fan-out/i);
    expect(p).not.toMatch(/at most \d+/i);
    expect(p).not.toMatch(/turn budget/i);
    expect(p).not.toMatch(/scheduler/i);
  });

  test("systemPrompt has DONE GATE for plan completeness", () => {
    const p = planPackage.systemPrompt;
    expect(p).toContain("DONE GATE");
    expect(p).toContain("success_criteria");
    expect(p).toMatch(/[Ss]top when/);
    expect(p).toContain("Blockers");
  });

  test("spawn.maySpawn is false", () => {
    expect(planPackage.spawn.maySpawn).toBe(false);
  });

  test("tools.allow is review surface with product writes", () => {
    const allow = planPackage.tools?.allow ?? [];
    expect(allow).toContain("read_file");
    expect(allow).toContain("write_file");
    expect(allow).toContain("edit_file");
    expect(allow).toContain("delete_file");
  });

  test("modelRole is plan", () => {
    expect(planPackage.modelRole).toBe("plan");
  });

  test("optionalSkills order", () => {
    expect(planPackage.optionalSkills).toEqual(["style", "philosophy", "interview"]);
  });

  test("primaryIntent and outOfLane match counsel / plan lane", () => {
    expect(planPackage.primaryIntent).toBe("Author ordered eng change plans; do not implement");
    expect(planPackage.description).toMatch(/Counsel/i);
    expect(planPackage.outOfLane).toContain("shipping code");
    expect(planPackage.outOfLane).toContain("architecture gate sign-off as Greybeard");
    expect(planPackage.outOfLane).toContain("running the fleet");
    expect(planPackage.outOfLane).toContain("pure code review");
    expect(planPackage.outOfLane).toContain("becoming Builder or Critic");
  });
});
