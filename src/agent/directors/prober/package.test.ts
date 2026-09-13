import { describe, expect, test } from "bun:test";
import { proberPackage } from "./package.js";

describe("proberPackage", () => {
  test("id matches directory / registry id", () => {
    expect(proberPackage.id).toBe("prober");
  });

  test("systemPrompt is non-empty and not a Placeholder", () => {
    expect(proberPackage.systemPrompt.length).toBeGreaterThan(0);
    expect(proberPackage.systemPrompt.startsWith("Placeholder")).toBe(false);
  });

  test("systemPrompt identity is Prober / ProberDirector", () => {
    const p = proberPackage.systemPrompt;
    expect(p).toMatch(/ProberDirector \(Prober\)/);
    expect(p).toContain("PRIMARY INTENT");
    expect(p).toMatch(/measure-only lane/i);
  });

  test("systemPrompt states the measure-only lane (TTFT, latency, streaks, salvage/nudge)", () => {
    const p = proberPackage.systemPrompt;
    expect(p).toMatch(/measure latency and behavior distributions/i);
    expect(p).toMatch(/TTFT/);
    expect(p).toMatch(/per-turn latency/i);
    expect(p).toMatch(/tool-only streak/i);
    expect(p).toMatch(/salvage counts/i);
    expect(p).toMatch(/nudge counts/i);
    expect(p).toMatch(/per family\/model/i);
  });

  test("systemPrompt forbids shipping product code and tuning prompts/policy", () => {
    const p = proberPackage.systemPrompt;
    expect(p).toMatch(/never ship product code/i);
    expect(p).toMatch(/never tune prompts or model-family policy/i);
    expect(p).toMatch(/never silent retunes/i);
  });

  test("systemPrompt consumes the existing harness (no second harness)", () => {
    const p = proberPackage.systemPrompt;
    expect(p).toContain("bun run eval:capability");
    expect(p).toContain("scripts/eval-capability.ts");
    expect(p).toContain("src/perf");
    expect(p).toContain("rollup.ts");
    expect(p).toContain("assert-spans.ts");
    expect(p).toContain("attribution-report.ts");
    expect(p).toMatch(/do not build a second one/i);
    expect(p).toMatch(/do not hand-roll/i);
  });

  test("systemPrompt routes findings to model-family-policy follow-ups", () => {
    const p = proberPackage.systemPrompt;
    expect(p).toContain("src/agent/model-family-policy.ts");
    expect(p).toMatch(/follow-up tickets/i);
    expect(p).toMatch(/do not edit the policy here/i);
  });

  test("systemPrompt points at the scaffold-owned worker report envelope (no re-spec)", () => {
    const p = proberPackage.systemPrompt;
    expect(p).toMatch(/Corbits report envelope/);
    expect(p).toMatch(/scaffold owns its shape/i);
    expect(p).not.toContain("## Summary");
    expect(p).not.toContain("## Findings");
    expect(p).not.toContain("## Blockers");
    expect(p).not.toContain("## Paths");
    expect(p).toMatch(/distributions per family\/model/i);
    expect(p).toMatch(/follow-up tickets for policy\/prompt owners/i);
    expect(p).toMatch(/DONE GATE/i);
    expect(p).toMatch(/BLINDERS ON/i);
    expect(p).toContain("success_criteria");
  });

  test("systemPrompt has no tool-schema restatement or fake caps", () => {
    const p = proberPackage.systemPrompt;
    expect(p).not.toMatch(/parameters?:/i);
    expect(p).not.toMatch(/fan-out/i);
    expect(p).not.toMatch(/at most \d+/i);
    expect(p).not.toMatch(/turn budget/i);
    expect(p).not.toMatch(/scheduler/i);
  });

  test("spawn.maySpawn is false (leaf)", () => {
    expect(proberPackage.spawn.maySpawn).toBe(false);
  });

  test("tier is leaf", () => {
    expect(proberPackage.tier).toBe("leaf");
  });

  test("tools.allow mounts the review surface (lane discipline in prompt)", () => {
    const allow = proberPackage.tools?.allow ?? [];
    expect(allow).toContain("read_file");
    expect(allow).toContain("run_shell");
    expect(allow).toContain("write_file");
    expect(allow).toContain("edit_file");
    expect(allow).toContain("delete_file");
  });

  test("modelRole is test", () => {
    expect(proberPackage.modelRole).toBe("test");
  });

  test("primaryIntent and outOfLane match the prober lane", () => {
    expect(proberPackage.primaryIntent).toMatch(/measure/i);
    expect(proberPackage.primaryIntent).toMatch(/never ship product code/i);
    expect(proberPackage.primaryIntent).toMatch(/never tune/i);
    const joined = proberPackage.outOfLane.join(" ");
    expect(joined).toMatch(/shipping product code/i);
    expect(joined).toMatch(/tuning prompts or model-family policy/i);
    expect(joined).toMatch(/new eval harness/i);
  });
});
