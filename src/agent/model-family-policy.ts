import { detectModelFamily, type ModelFamily } from "../subagent/provider-family.js";

/**
 * Per-model-family tuning for the shared directors (main chat director and
 * SubAgentDirector). One policy object, resolved once per session/leaf from
 * the provider/model — directors stay generic and branch on data, never on
 * per-family subclasses.
 */
export type ModelFamilyPolicy = {
  family: ModelFamily;
  /**
   * Consecutive tool-only assistant turns (tool calls, no text) before the
   * main chat director injects a one-shot wrap-up nudge.
   */
  toolOnlyTurnNudgeAt: number;
  /**
   * Consecutive tool-only assistant turns before the main chat director stops
   * issuing infers and surfaces a loud operator-facing pause.
   */
  toolOnlyTurnPauseAt: number;
  /** Ephemeral nudge text injected at toolOnlyTurnNudgeAt. */
  wrapUpNudgeText: string;
  /** Wall-clock inactivity, in ms, before a silent sub-agent leaf is nudged. */
  subAgentStallTimeoutMs: number;
  /** Grok's finish-bias residual (withhold from orchestrators; see provider-family.ts). */
  applyGrokFinishBias: boolean;
};

const DEFAULT_WRAP_UP_NUDGE_TEXT =
  "You have made several consecutive tool calls without any explanation. " +
  "Stop and summarize what you have done so far and what remains, or continue " +
  "if genuinely mid-task — but say so.";

const GROK_WRAP_UP_NUDGE_TEXT =
  "You are running long stretches of tool calls with no narration. Stop and " +
  "report progress now: what you have done, what is left, and whether you are " +
  "actually still making progress.";

// Permissive defaults: a busy-but-progressing session (tool turns interleaved
// with text) never trips these. Tightened only for families with observed
// runaway tool-only behavior (see grok below).
const DEFAULT_POLICY: Omit<ModelFamilyPolicy, "family"> = {
  toolOnlyTurnNudgeAt: 12,
  toolOnlyTurnPauseAt: 20,
  wrapUpNudgeText: DEFAULT_WRAP_UP_NUDGE_TEXT,
  subAgentStallTimeoutMs: 5 * 60_000,
  applyGrokFinishBias: false,
};

// xAI's own CLI ships main-session auto-pause for grok ("Goal auto-paused
// after N consecutive non-completing turns") — a directly observed 14-turn
// pure-tool-call session the operator had to cancel motivates tightening
// grok's thresholds below the shared default.
const GROK_POLICY: Omit<ModelFamilyPolicy, "family"> = {
  toolOnlyTurnNudgeAt: 6,
  toolOnlyTurnPauseAt: 10,
  wrapUpNudgeText: GROK_WRAP_UP_NUDGE_TEXT,
  subAgentStallTimeoutMs: 90_000,
  applyGrokFinishBias: true,
};

// Kimi (Moonshot) detection ships now so callers can branch on family, but
// thresholds are provisional: we have no eval characterization yet for how
// Kimi behaves under tool-only stretches or background-run stalls. Ship the
// permissive default rather than guessing at a tightened number; revisit
// once eval data exists.
const KIMI_POLICY: Omit<ModelFamilyPolicy, "family"> = { ...DEFAULT_POLICY };

export function resolveModelFamilyPolicy(input: {
  providerName: string;
  model?: string;
  orchestrator?: boolean;
}): ModelFamilyPolicy {
  const family = detectModelFamily(input);
  const orchestrator = input.orchestrator === true;
  switch (family) {
    case "grok": {
      const policy = { family, ...GROK_POLICY };
      // The finish-bias residual only makes sense on leaf workers, mirroring
      // shouldApplyGrokAntiThrash: orchestrators dispatch other agents rather
      // than doing the work directly.
      return { ...policy, applyGrokFinishBias: policy.applyGrokFinishBias && !orchestrator };
    }
    case "kimi":
      return { family, ...KIMI_POLICY };
    default:
      return { family: "default", ...DEFAULT_POLICY };
  }
}
