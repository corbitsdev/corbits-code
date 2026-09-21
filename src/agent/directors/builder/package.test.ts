import { describe, expect, test } from "bun:test";
import { builderPackage } from "./package.js";

describe("builderPackage", () => {
  test("systemPrompt identity is Builder / BuilderDirector (not job-title language)", () => {
    const p = builderPackage.systemPrompt;
    expect(p).toMatch(/BuilderDirector \(Builder\)/);
    expect(p).toMatch(/implementer worker/i);
    expect(p).not.toMatch(/build director/i);
  });

  test("systemPrompt is a short Corbits implement card, not the GaaS implement skill", () => {
    const p = builderPackage.systemPrompt;
    expect(p).toContain("Ship the brief");
    expect(p).toContain("success_criteria");
    expect(p).toMatch(/test-first/i);
    expect(p).toMatch(/assert expected behavior/i);
    expect(p).toContain("Blockers");
    expect(p).not.toContain("## Implement and Test");
    expect(p).not.toContain("## Prerequisites");
    expect(p).not.toContain("## Build Gate");
    expect(p).not.toContain("Greybeard Review");
    expect(p).not.toContain("TaskCreate");
    expect(p).not.toMatch(/Use the @greybeard subagent/i);
  });

  test("systemPrompt ships tests with the change and runs the repo gate", () => {
    const p = builderPackage.systemPrompt;
    expect(p).toMatch(/bun run check/);
    expect(p).toMatch(/Do not shortcut verify/i);
    expect(p).toMatch(/partial gates/i);
    expect(p).toMatch(/pre-existing/i);
    expect(p).toMatch(/do not invent one/i);
    expect(p).toMatch(/exact verification command/i);
    expect(p).toMatch(/exit status/);
    expect(p).toMatch(/bare "pass" without command evidence/i);
    expect(p).toMatch(/same commit when committing/);
  });

  test("systemPrompt has no philosophy boot", () => {
    const p = builderPackage.systemPrompt;
    expect(p).not.toMatch(/Before substantial repo work/i);
    expect(p).not.toMatch(
      /follow style, philosophy, native-runtime, idiot-proof, and Ponytail/i,
    );
    expect(p).not.toMatch(/load each with skill_search \+ use_skill/i);
    expect(p).not.toMatch(/use_skill is not mounted/i);
  });

  test("systemPrompt does not inline family residuals", () => {
    const p = builderPackage.systemPrompt;
    expect(p).not.toContain("Finish bias (xAI / Grok worker):");
    expect(p).not.toContain("Tool budget:");
    expect(p).not.toContain("<task_guidance>");
    expect(p).not.toContain("Narrate before tools (GPT worker):");
    expect(p).not.toContain("Tool discipline:");
  });

  test("systemPrompt stays a short card (no 53k harness blob)", () => {
    const p = builderPackage.systemPrompt;
    expect(p.length).toBeLessThan(4000);
    expect(p).not.toMatch(/parameters?:/i);
    expect(p).not.toMatch(/fan-out/i);
    expect(p).not.toMatch(/at most \d+/i);
    expect(p).not.toMatch(/turn budget/i);
    expect(p).not.toMatch(/scheduler/i);
  });

  test("systemPrompt requires a counsel / /plan plan for substantial work", () => {
    const p = builderPackage.systemPrompt;
    expect(p).toContain("counsel / `/plan` plan");
    expect(p).toContain("If that plan is missing from the brief");
    expect(p).toContain("do not invent one and do not ship");
    expect(p).toContain("Tiny parent-DIY edits are plan-optional");
    expect(p).toContain("`/implement` does not steal planning from `/plan`");
  });

  test("systemPrompt is implement leaf only (no orchestrate / spawn / review-as-primary)", () => {
    const p = builderPackage.systemPrompt;
    expect(p).toMatch(/Do not spawn specialists/i);
    expect(p).toMatch(/maySpawn:false/);
    expect(p).toMatch(/not Critic/i);
    expect(p).toMatch(/not Explorer/i);
    expect(p).toMatch(/not an orchestrator/i);
    expect(p).toMatch(/@greybeard/i);
    expect(p).toMatch(/@critic/i);
    expect(p).toMatch(/report Blockers for the parent/i);
    expect(p).not.toMatch(/Spawn the @critic/i);
    expect(p).not.toMatch(/Use the @greybeard subagent/i);
  });

  test("systemPrompt prefers working tree over committing unless brief requires it", () => {
    const p = builderPackage.systemPrompt;
    expect(p).toMatch(/does NOT commit unless/i);
    expect(p).toMatch(/working tree \+ report/i);
  });

  test("modelRole is implement", () => {
    expect(builderPackage.modelRole).toBe("implement");
  });

  test("optionalSkills order is style, philosophy, native-runtime, idiot-proof, ponytail", () => {
    expect(builderPackage.optionalSkills).toEqual([
      "style",
      "philosophy",
      "native-runtime",
      "idiot-proof",
      "ponytail",
    ]);
  });

  test("primaryIntent and outOfLane reinforce lane discipline", () => {
    expect(builderPackage.primaryIntent).toMatch(/nothing more|brief/i);
    expect(builderPackage.outOfLane).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/architecture/i),
        expect.stringMatching(/scope/i),
        expect.stringMatching(/spawn/i),
      ]),
    );
  });

  test("systemPrompt stays in lane without branded Corbits banner titles", () => {
    const prompt = builderPackage.systemPrompt;
    expect(prompt).toContain("Stay in lane");
    expect(prompt).not.toContain("DONE GATE");
    expect(prompt).not.toContain("REPORT MAP");
    expect(prompt).not.toContain("API CONTRACT");
  });

  test("systemPrompt stops when success_criteria are met", () => {
    const prompt = builderPackage.systemPrompt;
    expect(prompt).toContain("success_criteria");
    expect(prompt).toMatch(/[Ss]top when/);
    expect(prompt).toMatch(/do not invent architecture|nothing more/i);
  });

  test("systemPrompt reports criteria status for parent routing", () => {
    const prompt = builderPackage.systemPrompt;
    expect(prompt).toMatch(/Findings/i);
    expect(prompt).toMatch(/pass, fail, or blocked/);
    expect(prompt).toMatch(/Paths must list files touched/);
    expect(prompt).toMatch(/Summary \/ Findings \/ Blockers \/ Paths/);
  });

  test("systemPrompt wires docs routing, testsmith consumer, and branch/PR shape", () => {
    const p = builderPackage.systemPrompt;
    expect(p).toMatch(/testsmith/);
    expect(p).toMatch(/route a tester run/);
    expect(p).toMatch(/shakespeare docs pass/);
    expect(p).toMatch(/branch name carries the issue id/i);
    expect(p).toMatch(/Fixes CL-/);
    expect(p).toMatch(/no AI-attribution lines/);
  });

  test("systemPrompt preserves public API sync/async", () => {
    const prompt = builderPackage.systemPrompt;
    expect(prompt).toMatch(/public API/i);
    expect(prompt).toMatch(/sync\/async/);
  });
});
