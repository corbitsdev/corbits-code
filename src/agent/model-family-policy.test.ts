import { describe, expect, test } from "bun:test";
import { resolveModelFamilyPolicy } from "./model-family-policy.js";

describe("resolveModelFamilyPolicy", () => {
  test("defaults are permissive for an unrecognized provider", () => {
    const policy = resolveModelFamilyPolicy({
      providerName: "unknown-provider",
      model: "unknown-model",
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
      providerName: "unknown-provider",
      model: "unknown-model",
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
      // Default-family probe: anthropic/claude-sonnet-4 hits the claude row
      // and openai/gpt-4.1 hits the gpt row (#1135), so an unrecognized
      // provider is the probe that still resolves to the default family.
      const base = resolveModelFamilyPolicy({
        providerName: "unknown-provider",
        model: "unknown-model",
      });
      expect(base.family).toBe("default");
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
    expect(leaf.advertisedToolDeny).toEqual([]);
    const orchestrator = resolveModelFamilyPolicy({
      providerName: "anthropic",
      model: "claude-sonnet-4",
      orchestrator: true,
    });
    expect(orchestrator.promptResidual).toBeUndefined();
  });

  // The gpt family row has landed (#1135): openai/gpt-4.1 and codex/gpt-5.1
  // resolve to the gpt family with the narrate-before-tools residual, leaf
  // and orchestrator alike (no carve-out). Grok keeps its CL-8297 tool-budget
  // residual — the "no residual" claim below is default-family-only.
  test("gpt probes resolve to gpt with the narrate residual; grok keeps its tool budget", () => {
    for (const input of [
      { providerName: "openai", model: "gpt-4.1" },
      { providerName: "codex", model: "gpt-5.1" },
    ] as const) {
      for (const orchestrator of [false, true]) {
        const policy = resolveModelFamilyPolicy({ ...input, orchestrator });
        expect(policy.family).toBe("gpt");
        expect(policy.promptResidual).toContain(
          "Narrate before tools (GPT worker):",
        );
      }
    }
    const grok = resolveModelFamilyPolicy({
      providerName: "xai/default",
      model: "grok-4.6",
      orchestrator: false,
    });
    expect(grok.family).toBe("grok");
    expect(grok.promptResidual).toContain("Tool budget:");
  });
  test("gpt resolves its own family on permissive default thresholds (CL-8310)", () => {
    const gpt = resolveModelFamilyPolicy({
      providerName: "codex/default",
      model: "gpt-5.5",
    });
    const base = resolveModelFamilyPolicy({
      providerName: "anthropic",
      model: "claude-sonnet-4",
    });
    expect(gpt.family).toBe("gpt");
    // No eval characterization for gpt tool-only stretches yet: ship the
    // permissive default, no finish-bias, no discipline rules. The
    // narrate-before-tools residual is prompt-level (see prompts.ts), not a
    // threshold.
    expect(gpt.toolOnlyTurnNudgeAt).toBe(base.toolOnlyTurnNudgeAt);
    expect(gpt.subAgentStallTimeoutMs).toBe(base.subAgentStallTimeoutMs);
    expect(gpt.applyGrokFinishBias).toBe(false);
    expect(gpt.toolDisciplineRules).toBeUndefined();
    expect(gpt.advertisedToolDeny).toEqual([]);
  });
});
