import { describe, expect, test } from "bun:test";
import { builderPackage } from "./package.js";

describe("builderPackage", () => {
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

  test("modelRole is implement", () => {
    expect(builderPackage.modelRole).toBe("implement");
  });

  test("attachedSkills are style and philosophy; optionalSkills are on-demand", () => {
    expect(builderPackage.attachedSkills).toEqual(["style", "philosophy"]);
    expect(builderPackage.optionalSkills).toEqual([
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
});
