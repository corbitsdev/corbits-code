import { describe, expect, test } from "bun:test";
import { resolveModelFamilyPolicy } from "./model-family-policy.js";

describe("resolveModelFamilyPolicy", () => {
  test("defaults are permissive for an unrecognized provider", () => {
    const policy = resolveModelFamilyPolicy({ providerName: "anthropic", model: "claude-sonnet-4" });
    expect(policy.family).toBe("default");
    expect(policy.applyGrokFinishBias).toBe(false);
    expect(policy.toolOnlyTurnNudgeAt).toBeGreaterThan(20);
    expect(policy.toolOnlyNoProgressRepeatLimit).toBeGreaterThan(1);
  });

  test("grok no longer tightens the tool-only nudge/pause thresholds below the default", () => {
    const grok = resolveModelFamilyPolicy({ providerName: "xai/default", model: "grok-4.5" });
    const base = resolveModelFamilyPolicy({ providerName: "anthropic", model: "claude-sonnet-4" });
    expect(grok.family).toBe("grok");
    expect(grok.toolOnlyTurnNudgeAt).toBe(base.toolOnlyTurnNudgeAt);
    expect(grok.toolOnlyNoProgressRepeatLimit).toBe(base.toolOnlyNoProgressRepeatLimit);
    expect(grok.subAgentStallTimeoutMs).toBeLessThan(base.subAgentStallTimeoutMs);
  });

  test("grok finish-bias applies to leaves but not orchestrators", () => {
    const leaf = resolveModelFamilyPolicy({ providerName: "xai/default", orchestrator: false });
    const orchestrator = resolveModelFamilyPolicy({ providerName: "xai/default", orchestrator: true });
    expect(leaf.applyGrokFinishBias).toBe(true);
    expect(orchestrator.applyGrokFinishBias).toBe(false);
  });

  test("kimi is detected but ships the permissive default thresholds", () => {
    const kimi = resolveModelFamilyPolicy({ providerName: "moonshot", model: "kimi-k2" });
    const base = resolveModelFamilyPolicy({ providerName: "anthropic", model: "claude-sonnet-4" });
    expect(kimi.family).toBe("kimi");
    expect(kimi.toolOnlyTurnNudgeAt).toBe(base.toolOnlyTurnNudgeAt);
    expect(kimi.toolOnlyNoProgressRepeatLimit).toBe(base.toolOnlyNoProgressRepeatLimit);
    expect(kimi.subAgentStallTimeoutMs).toBe(base.subAgentStallTimeoutMs);
  });

  test("no-progress repeat limit is a small, real number for every family", () => {
    for (const providerName of ["xai/default", "moonshot", "anthropic"]) {
      const policy = resolveModelFamilyPolicy({ providerName });
      expect(policy.toolOnlyNoProgressRepeatLimit).toBeGreaterThanOrEqual(2);
      expect(policy.toolOnlyNoProgressRepeatLimit).toBeLessThan(policy.toolOnlyTurnNudgeAt);
    }
  });
});
