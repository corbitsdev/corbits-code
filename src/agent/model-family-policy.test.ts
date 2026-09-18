import { describe, expect, test } from "bun:test";
import { resolveModelFamilyPolicy } from "./model-family-policy.js";

describe("resolveModelFamilyPolicy", () => {
  test("defaults are permissive for an unrecognized provider", () => {
    const policy = resolveModelFamilyPolicy({
      providerName: "anthropic",
      model: "claude-sonnet-4",
    });
    expect(policy.family).toBe("default");
    expect(policy.applyGrokFinishBias).toBe(false);
    expect(policy.toolOnlyTurnNudgeAt).toBeGreaterThan(20);
  });

  test("grok shares the default sub-agent stall timeout (thinking gaps are long)", () => {
    const grok = resolveModelFamilyPolicy({
      providerName: "xai/default",
      model: "grok-4.5",
    });
    const base = resolveModelFamilyPolicy({
      providerName: "anthropic",
      model: "claude-sonnet-4",
    });
    expect(grok.family).toBe("grok");
    expect(grok.toolOnlyTurnNudgeAt).toBe(base.toolOnlyTurnNudgeAt);
    expect(grok.subAgentStallTimeoutMs).toBe(base.subAgentStallTimeoutMs);
  });

  test("grok finish-bias applies to leaves but not orchestrators", () => {
    const leaf = resolveModelFamilyPolicy({
      providerName: "xai/default",
      orchestrator: false,
    });
    const orchestrator = resolveModelFamilyPolicy({
      providerName: "xai/default",
      orchestrator: true,
    });
    expect(leaf.applyGrokFinishBias).toBe(true);
    expect(orchestrator.applyGrokFinishBias).toBe(false);
  });

  test("kimi is detected but ships the permissive default thresholds", () => {
    const kimi = resolveModelFamilyPolicy({
      providerName: "moonshot",
      model: "kimi-k2",
    });
    const base = resolveModelFamilyPolicy({
      providerName: "anthropic",
      model: "claude-sonnet-4",
    });
    expect(kimi.family).toBe("kimi");
    expect(kimi.toolOnlyTurnNudgeAt).toBe(base.toolOnlyTurnNudgeAt);
    expect(kimi.subAgentStallTimeoutMs).toBe(base.subAgentStallTimeoutMs);
  });

  test("advertisedToolDeny is empty by default and never contains use_skill", () => {
    const leaf = resolveModelFamilyPolicy({
      providerName: "anthropic",
      model: "claude-opus-4-6",
      orchestrator: false,
    });
    expect(leaf.advertisedToolDeny).toEqual([]);
    expect(leaf.advertisedToolDeny).not.toContain("use_skill");
  });

  test("grok and kimi leaves deny skill_search only", () => {
    for (const input of [
      { providerName: "xai", model: "grok-4-1-fast-non-reasoning" },
      { providerName: "moonshot", model: "kimi-k2-0711" },
    ] as const) {
      const leaf = resolveModelFamilyPolicy({
        ...input,
        orchestrator: false,
      });
      expect(leaf.advertisedToolDeny).toEqual(["skill_search"]);
      expect(leaf.advertisedToolDeny).not.toContain("use_skill");
    }
  });

  test("orchestrators keep the full surface on every family", () => {
    for (const input of [
      { providerName: "xai", model: "grok-4-1-fast-non-reasoning" },
      { providerName: "moonshot", model: "kimi-k2-0711" },
      { providerName: "anthropic", model: "claude-opus-4-6" },
    ] as const) {
      const policy = resolveModelFamilyPolicy({ ...input, orchestrator: true });
      expect(policy.advertisedToolDeny).toEqual([]);
    }
  });

  test("muse spark carries tool-discipline rules; other families do not", () => {
    const muse = resolveModelFamilyPolicy({
      providerName: "opencode-go/abklabs",
      model: "muse-spark-1.3-contributor",
    });
    const base = resolveModelFamilyPolicy({
      providerName: "anthropic",
      model: "claude-sonnet-4",
    });
    expect(muse.family).toBe("muse");
    expect(muse.toolDisciplineRules).toContain("Batch independent tool calls");
    expect(muse.toolDisciplineRules).toContain("Never re-read a file");
    expect(base.toolDisciplineRules).toBeUndefined();
  });

  describe("promptResidual (CL-8297)", () => {
    test("grok leaf carries the generic 4-line tool-budget residual", () => {
      const leaf = resolveModelFamilyPolicy({
        providerName: "xai/default",
        model: "grok-4.6",
      });
      expect(leaf.family).toBe("grok");
      expect(leaf.promptResidual).toBeDefined();
      if (!leaf.promptResidual)
        throw new Error("expected promptResidual to be defined");
      expect(leaf.promptResidual.split("\n")).toHaveLength(4);
      expect(leaf.promptResidual).toContain("Tool budget:");
    });

    test("grok orchestrators and default family carry no residual", () => {
      const orchestrator = resolveModelFamilyPolicy({
        providerName: "xai/default",
        model: "grok-4.6",
        orchestrator: true,
      });
      expect(orchestrator.promptResidual).toBeUndefined();
      const base = resolveModelFamilyPolicy({
        providerName: "anthropic",
        model: "claude-sonnet-4",
      });
      expect(base.promptResidual).toBeUndefined();
    });
  });

  test("claude leaves carry the XML task_guidance residual; orchestrators do not", () => {
    const leaf = resolveModelFamilyPolicy({
      providerName: "anthropic",
      model: "claude-sonnet-4",
      orchestrator: false,
    });
    expect(leaf.family).toBe("claude");
    expect(leaf.promptResidual).toContain("<task_guidance>");
    expect(leaf.promptResidual).toContain("</task_guidance>");
    const orchestrator = resolveModelFamilyPolicy({
      providerName: "anthropic",
      model: "claude-sonnet-4",
      orchestrator: true,
    });
    expect(orchestrator.promptResidual).toBeUndefined();
  });

  // The gpt family row has NOT landed yet (#1135): openai/gpt-4.1 and
  // codex/gpt-5.1 are default-family probes here, asserting they resolve to
  // the default family with no residual. Grok keeps its CL-8297 tool-budget
  // residual — the "no residual" claim below is default-family-only.
  test("gpt probes resolve to default with no residual; grok keeps its tool budget", () => {
    for (const input of [
      { providerName: "openai", model: "gpt-4.1" },
      { providerName: "codex", model: "gpt-5.1" },
    ] as const) {
      const policy = resolveModelFamilyPolicy({
        ...input,
        orchestrator: false,
      });
      expect(policy.family).toBe("default");
      expect(policy.promptResidual).toBeUndefined();
    }
    const grok = resolveModelFamilyPolicy({
      providerName: "xai/default",
      model: "grok-4.6",
      orchestrator: false,
    });
    expect(grok.family).toBe("grok");
    expect(grok.promptResidual).toContain("Tool budget:");
  });
});
