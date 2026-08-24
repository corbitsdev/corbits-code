import { detectModelFamily, type ModelFamily } from "../subagent/provider-family.js";

/**
 * Per-model-family tuning for the shared directors (main chat director and
 * SubAgentDirector). One policy object, resolved once per session/leaf from
 * the provider/model — directors stay generic and branch on data, never on
 * per-family subclasses.
 */
export interface ModelFamilyPolicy {
  family: ModelFamily;
  /**
   * Consecutive tool-only assistant turns (tool calls, no text) before the
   * main chat director injects a one-shot wrap-up nudge. A long tool-only
   * streak is normal orchestration (Linear lookups, code reads, etc.) and
   * must not by itself stop the session — this is a soft check-in, and it
   * never escalates to a pause on its own.
   */
  toolOnlyTurnNudgeAt: number;
  /** Ephemeral nudge text injected at toolOnlyTurnNudgeAt. */
  wrapUpNudgeText: string;
  /** Wall-clock inactivity, in ms, before a silent sub-agent leaf is nudged. */
  subAgentStallTimeoutMs: number;
  /** Grok's finish-bias residual (withhold from orchestrators; see provider-family.ts). */
  applyGrokFinishBias: boolean;
}

const DEFAULT_WRAP_UP_NUDGE_TEXT =
  "You have made several consecutive tool calls without any explanation. " +
  "Stop and summarize what you have done so far and what remains, or continue " +
  "if genuinely mid-task — but say so.";

const GROK_WRAP_UP_NUDGE_TEXT =
  "You are running long stretches of tool calls with no narration. Stop and " +
  "report progress now: what you have done, what is left, and whether you are " +
  "actually still making progress.";

// Forensics on real session traces (see CL-5611, and the extended scan in
// scripts/tool-fingerprint-forensics.ts, 328 sessions with a tool-only run /
// 559 tool-only runs) found healthy tool-only streaks topping out at 28
// consecutive turns (p50 3, p90 8, p99 16) and zero repeating
// tool-fingerprint cycles for any period the scan checked (1 through 6). 25
// sits comfortably above the observed healthy ceiling; the nudge is a
// check-in, not a stop, so erring high costs nothing. Tightened only for
// families with observed runaway tool-only behavior (see grok below).
const DEFAULT_POLICY: Omit<ModelFamilyPolicy, "family"> = {
  toolOnlyTurnNudgeAt: 25,
  wrapUpNudgeText: DEFAULT_WRAP_UP_NUDGE_TEXT,
  subAgentStallTimeoutMs: 5 * 60_000,
  applyGrokFinishBias: false,
};

// A directly observed 14-turn pure-tool-call session for this family
// previously motivated a tightened nudge/pause pair here (6/10). That pair
// was miscalibrated: it fired on a session that was making real progress
// through Linear lookups and code reads (CL-5611), well inside the healthy
// range other families tolerate. Grok keeps its own nudge copy — still
// warranted — but shares the default sub-agent stall timeout: live
// workbench fleets on grok-4.6 show routine 60–180s gaps between tool
// cycles while the model thinks, so a sub-2-minute kill was false-positive
// salvage mid-inference. The hard-pause thrash check is not family-tuned;
// it runs the same period detection for every family.
const GROK_POLICY: Omit<ModelFamilyPolicy, "family"> = {
  toolOnlyTurnNudgeAt: DEFAULT_POLICY.toolOnlyTurnNudgeAt,
  wrapUpNudgeText: GROK_WRAP_UP_NUDGE_TEXT,
  subAgentStallTimeoutMs: DEFAULT_POLICY.subAgentStallTimeoutMs,
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
