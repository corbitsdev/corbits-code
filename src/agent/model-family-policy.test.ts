import { describe, expect, test } from "bun:test";
import { resolveModelFamilyPolicy } from "./model-family-policy.js";
import { buildSubAgentSystemPrompt } from "./prompts.js";

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

  test("grok and kimi leaves do not deny skill_search", () => {
    for (const input of [
      { providerName: "xai", model: "grok-4-1-fast-non-reasoning" },
      { providerName: "moonshot", model: "kimi-k2-0711" },
    ] as const) {
      const leaf = resolveModelFamilyPolicy({
        ...input,
        orchestrator: false,
      });
      expect(leaf.advertisedToolDeny).toEqual([]);
      expect(leaf.advertisedToolDeny).not.toContain("skill_search");
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
      providerName: "opencode-go/acme",
      model: "muse-spark-1.3-contributor",
    });
    const base = resolveModelFamilyPolicy({
      providerName: "anthropic",
      model: "claude-sonnet-4",
    });
    expect(muse.family).toBe("muse");
    expect(muse.toolDisciplineRules?.length).toBeGreaterThan(0);
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
    });

    test("grok orchestrators and default family carry no residual", () => {
      const orchestrator = resolveModelFamilyPolicy({
        providerName: "xai/default",
        model: "grok-4.6",
        orchestrator: true,
      });
      expect(orchestrator.promptResidual).toBeUndefined();
      // Default-family probe: anthropic/claude-sonnet-4 hits the claude row
      // and openai/gpt-5.6 hits the gpt row (#1135), so an unrecognized
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
    expect(leaf.promptResidual).toBeDefined();
    expect(leaf.advertisedToolDeny).toEqual([]);
    const orchestrator = resolveModelFamilyPolicy({
      providerName: "anthropic",
      model: "claude-sonnet-4",
      orchestrator: true,
    });
    expect(orchestrator.promptResidual).toBeUndefined();
  });

  // The gpt family row has landed (#1135): openai/gpt-5.6 and codex/gpt-5.1
  // resolve to the gpt family with the narrate-before-tools residual, leaf
  // and orchestrator alike (no carve-out). Grok keeps its CL-8297 tool-budget
  // residual — the "no residual" claim below is default-family-only.
  test("gpt probes resolve to gpt with the narrate residual; grok keeps its tool budget", () => {
    for (const input of [
      { providerName: "openai", model: "gpt-5.6" },
      { providerName: "codex", model: "gpt-5.1" },
    ] as const) {
      for (const orchestrator of [false, true]) {
        const policy = resolveModelFamilyPolicy({ ...input, orchestrator });
        expect(policy.family).toBe("gpt");
        expect(policy.promptResidual).toBeDefined();
      }
    }
    const grok = resolveModelFamilyPolicy({
      providerName: "xai/default",
      model: "grok-4.6",
      orchestrator: false,
    });
    expect(grok.family).toBe("grok");
    expect(grok.promptResidual).toBeDefined();
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

  describe("astra repro trace (CL-9027)", () => {
    // Minimal failing session-trace fixture: 8 consecutive tool-only turns
    // from a gpt-6-astra leaf (tool names + args + result sizes per turn).
    // Fingerprint and repeat-count semantics mirror
    // scripts/tool-fingerprint-forensics.ts (stableJson exact signatures,
    // largest exact-repeat count per period 1-6): the shared threshold guard
    // fires only on exact repeats, so a loop that varies trivial argument
    // details escapes it. That is evasion, not threshold-tolerated waste —
    // and the Step-3 residual forbids exactly this variation. The
    // near-identical grouping below is test-only forensics; no signature
    // normalization ships in first-party code.
    interface ReproTurn {
      tool: string;
      args: Record<string, unknown>;
      resultTokens: number;
    }
    const ASTRA_REPRO_TRACE: readonly ReproTurn[] = [
      {
        tool: "read",
        args: { path: "src/agent/prompts.ts" },
        resultTokens: 3200,
      },
      {
        tool: "read",
        args: { path: "./src/agent/prompts.ts" },
        resultTokens: 3200,
      },
      {
        tool: "read",
        args: { path: "src/agent/prompts.ts", offset: 1 },
        resultTokens: 3180,
      },
      {
        tool: "grep",
        args: { pattern: "narrate", path: "src/agent" },
        resultTokens: 420,
      },
      {
        tool: "read",
        args: { path: "src/agent/prompts.ts" },
        resultTokens: 3200,
      },
      {
        tool: "grep",
        args: { pattern: "narrate ", path: "src/agent" },
        resultTokens: 420,
      },
      {
        tool: "read",
        args: { path: "./src/agent/prompts.ts", limit: 2000 },
        resultTokens: 3200,
      },
      {
        tool: "read",
        args: { path: "src/agent/prompts.ts", offset: 0 },
        resultTokens: 3200,
      },
    ];

    function stableJson(value: unknown): string {
      if (value === null || typeof value !== "object")
        return JSON.stringify(value);
      if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(",")}}`;
    }

    function fingerprint(turn: ReproTurn): string {
      return `${turn.tool}:${stableJson(turn.args)}`;
    }

    function maxExactRepeats(fps: readonly string[]): number {
      let best = 1;
      for (let period = 1; period <= 6; period++) {
        for (let end = 1; end <= fps.length; end++) {
          const prefix = fps.slice(0, end);
          let i = prefix.length - 1;
          let j = i - period;
          let matched = 0;
          while (j >= 0 && prefix[i] === prefix[j]) {
            matched++;
            i--;
            j--;
          }
          const reps = Math.floor((matched + period) / period);
          if (reps > best) best = reps;
        }
      }
      return best;
    }

    function evasionKey(turn: ReproTurn): string {
      const args = { ...turn.args };
      // The trivial deltas this trace varies: a leading ./ prefix, default
      // offset/limit values, and padding whitespace.
      if (typeof args.path === "string")
        args.path = args.path.replace(/^\.\//, "");
      if (args.offset === 0 || args.offset === 1) delete args.offset;
      if (typeof args.limit === "number") delete args.limit;
      if (typeof args.pattern === "string") args.pattern = args.pattern.trim();
      return `${turn.tool}:${stableJson(args)}`;
    }

    function classifyAstraTrace(trace: readonly ReproTurn[]): string {
      if (maxExactRepeats(trace.map(fingerprint)) >= 3) return "waste";
      const groups = new Map<string, number>();
      for (const turn of trace) {
        const key = evasionKey(turn);
        groups.set(key, (groups.get(key) ?? 0) + 1);
      }
      return Math.max(...groups.values()) >= 3 ? "evasion" : "waste";
    }

    test("classifies as evasion: no exact repeat trips the shared guard", () => {
      expect(ASTRA_REPRO_TRACE).toHaveLength(8);
      expect(maxExactRepeats(ASTRA_REPRO_TRACE.map(fingerprint))).toBeLessThan(
        3,
      );
      expect(classifyAstraTrace(ASTRA_REPRO_TRACE)).toBe("evasion");
    });

    test("pins the offending pattern and the wasted turn/token delta", () => {
      const groups = new Map<string, number>();
      for (const turn of ASTRA_REPRO_TRACE) {
        const key = evasionKey(turn);
        groups.set(key, (groups.get(key) ?? 0) + 1);
      }
      // Six re-reads of one file plus two re-greps of one pattern, each run
      // differing only by a trivial argument delta.
      expect(groups.get('read:{"path":"src/agent/prompts.ts"}')).toBe(6);
      expect(groups.get('grep:{"path":"src/agent","pattern":"narrate"}')).toBe(
        2,
      );
      const wastedTokens = ASTRA_REPRO_TRACE.reduce(
        (sum, turn) => sum + turn.resultTokens,
        0,
      );
      expect(wastedTokens).toBe(20020);
    });
  });

  test("astra resolves to astra with the composed residual; thresholds stay default (CL-9027)", () => {
    const base = resolveModelFamilyPolicy({
      providerName: "unknown-provider",
      model: "unknown-model",
    });
    const gpt = resolveModelFamilyPolicy({
      providerName: "openai",
      model: "gpt-5.6",
    });
    for (const orchestrator of [false, true]) {
      const astra = resolveModelFamilyPolicy({
        providerName: "codex/default",
        model: "gpt-6-astra",
        orchestrator,
      });
      expect(astra.family).toBe("astra");
      // Keeps the gpt narrate nudge and adds the evasion-specific rules.
      expect(astra.promptResidual).toContain(
        "Narrate before tools (GPT worker):",
      );
      expect(astra.promptResidual).toContain("trivial argument changes");
      expect(astra.promptResidual).not.toBe(gpt.promptResidual);
      // Evasion earns a forbidding residual, not tighter thresholds.
      expect(astra.toolOnlyTurnNudgeAt).toBe(base.toolOnlyTurnNudgeAt);
      expect(astra.subAgentStallTimeoutMs).toBe(base.subAgentStallTimeoutMs);
      expect(astra.applyGrokFinishBias).toBe(false);
      expect(astra.toolDisciplineRules).toBeUndefined();
      expect(astra.advertisedToolDeny).toEqual([]);
    }
  });

  test("sol and generic gpt stay gpt with the byte-identical narrate residual", () => {
    const generic = resolveModelFamilyPolicy({
      providerName: "openai",
      model: "gpt-5.6",
    });
    for (const model of [
      "gpt-5.6-sol",
      "gpt-5.5",
      "gpt-5.6-luna",
      "gpt-5.6-terra",
    ] as const) {
      for (const orchestrator of [false, true]) {
        const policy = resolveModelFamilyPolicy({
          providerName: "codex/default",
          model,
          orchestrator,
        });
        expect(policy.family).toBe("gpt");
        expect(policy.promptResidual).toBe(generic.promptResidual);
      }
    }
  });

  describe("deepseek-v4 bake-in (CL-10242)", () => {
    function v4(
      input: {
        orchestrator?: boolean;
        directorId?: string;
      } = {},
    ) {
      return resolveModelFamilyPolicy({
        providerName: "vast",
        model: "deepseek-v4-flash",
        ...(input.orchestrator !== undefined
          ? { orchestrator: input.orchestrator }
          : {}),
        ...(input.directorId !== undefined
          ? { directorId: input.directorId }
          : {}),
      });
    }

    test("orchestrators get the d1 primary residual, no leaf role body", () => {
      const p = v4({ orchestrator: true });
      expect(p.family).toBe("deepseek");
      expect(p.promptResidual).toBeDefined();
      expect(p.promptResidual).toContain("DeepSeek V4 Flash");
      expect(p.leafRoleBody).toBeUndefined();
    });

    test("coder leaves get the tuned slim coder body, no residual", () => {
      const p = v4({ orchestrator: false, directorId: "coder" });
      expect(p.family).toBe("deepseek");
      expect(p.leafRoleBody).toBeDefined();
      expect(p.leafRoleBody).toContain("Coder");
      expect(p.promptResidual).toBeUndefined();
    });

    test("reviewer leaves get the tuned slim reviewer body", () => {
      const p = v4({ orchestrator: false, directorId: "reviewer" });
      expect(p.family).toBe("deepseek");
      expect(p.leafRoleBody).toBeDefined();
      expect(p.leafRoleBody).toContain("Reviewer");
      expect(p.promptResidual).toBeUndefined();
    });

    test("explorer leaves get the g2 leaf residual only", () => {
      const p = v4({ orchestrator: false, directorId: "explorer" });
      expect(p.family).toBe("deepseek");
      expect(p.promptResidual).toBeDefined();
      expect(p.promptResidual).toContain("DeepSeek V4 Flash");
      expect(p.leafRoleBody).toBeUndefined();
    });

    test("a leaf without a tuned director id gets the default policy, no body/residual", () => {
      const p = v4({ orchestrator: false });
      expect(p.family).toBe("deepseek");
      expect(p.leafRoleBody).toBeUndefined();
      expect(p.promptResidual).toBeUndefined();
    });

    test("the slim coder body lands in the assembled sub-agent prompt via the extensions seam", () => {
      const p = v4({ orchestrator: false, directorId: "coder" });
      const slimBody = p.leafRoleBody;
      expect(slimBody).toBeDefined();
      const prompt = buildSubAgentSystemPrompt([slimBody as string]);
      expect(prompt).toContain("You are Coder");
      expect(prompt).toContain("implement one brief");
    });
  });
});
