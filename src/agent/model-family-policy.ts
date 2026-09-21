import {
  detectModelFamily,
  type ModelFamily,
} from "../subagent/provider-family.js";

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
  /**
   * Tool names to drop from the advertised wire prefix and the dispatch gate
   * (CL-7668). Empty by default; grok/kimi leaves deny `skill_search` only and
   * load brief-named skills straight through `use_skill`, which is never
   * denied. Orchestrators keep the full surface.
   */
  advertisedToolDeny: readonly string[];
  /**
   * Tool-discipline rules appended to the system prompt for families that do
   * not self-terminate a tool loop. Empty for families that need none. Appended
   * at the tail so it cannot disturb the cached prompt prefix.
   */
  toolDisciplineRules?: string;
  /**
   * Provider-family residual appended once to the assembled leaf system
   * prompt (CL-8297). Generic tool-budget text today (grok only); the
   * ceremony / Claude / GPT seams stay unfilled in sibling lanes. Withheld
   * from orchestrators and appended at the tail so it cannot disturb the
   * cached prompt prefix. Undefined for families that need none.
   */
  promptResidual?: string | undefined;
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
  advertisedToolDeny: [],
};

// Generic 4-line tool-budget residual (CL-8297). Grok leaves get this via
// promptResidual today; other families leave the seam unfilled until their
// own lanes land. Deliberately free of ceremony lines and family-specific
// routing — pure tool-loop budget.
export const GROK_TOOL_BUDGET_RESIDUAL =
  "Tool budget:\n" +
  "- Batch independent tool calls into a single turn.\n" +
  "- Never re-issue a tool call whose result you already have.\n" +
  "- When the next call would only repeat prior work, write the report instead.";

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
  // Leaf value; the resolver clears it for orchestrators below.
  advertisedToolDeny: ["skill_search"],
  // Leaf value; the resolver clears it for orchestrators below.
  promptResidual: GROK_TOOL_BUDGET_RESIDUAL,
};

// Kimi (Moonshot) detection ships now so callers can branch on family, but
// thresholds are provisional: we have no eval characterization yet for how
// Kimi behaves under tool-only stretches or background-run stalls. Ship the
// permissive default rather than guessing at a tightened number; revisit
// once eval data exists.
const KIMI_POLICY: Omit<ModelFamilyPolicy, "family"> = { ...DEFAULT_POLICY };

// Muse Spark does not reliably stop a tool loop at medium reasoning effort: on
// a two-file fixture with a bounded fix it re-read files it had already read
// and ran out the 8-turn ceiling without finishing. The same run with these
// three rules appended finished in 3 turns on 4.3x fewer input tokens. At
// minimal effort it terminates either way, so the rules earn their keep exactly
// at the rungs where each wasted turn is most expensive. See CL-7869.
const MUSE_TOOL_DISCIPLINE_RULES =
  "Tool discipline:\n" +
  "- Batch independent tool calls into a single turn.\n" +
  "- Never re-read a file you have already read this session.\n" +
  "- Do not narrate; act.";

const MUSE_POLICY: Omit<ModelFamilyPolicy, "family"> = {
  ...DEFAULT_POLICY,
  toolDisciplineRules: MUSE_TOOL_DISCIPLINE_RULES,
};

// Single grok finish-bias + ceremony residual (CL-8296): the finish-bias
// bullets plus the three ceremony lines from the CL-7768 design (no git, no
// pre-plan, verify once), merged into one block with no line twice. The don't
// re-read idea appears exactly once (the "re-open paths" bullet) — it is not
// repeated. Grok-only: detectModelFamily has no glm family, so per the <30min
// rule no GLM row ships here. The text lives here once; exported for
// buildGrokLeafAntiThrashNote (prompts.ts), which returns it verbatim, so the
// prompt carries exactly one copy. This is a different block from the CL-8297
// tool-budget hook (GROK_TOOL_BUDGET_RESIDUAL, surfaced via the
// ModelFamilyPolicy.promptResidual field): grok leaves carry both, each once.
export const GROK_PROMPT_RESIDUAL = [
  "Finish bias (xAI / Grok worker):",
  "- Once you can answer the dispatch brief, prefer the structured report over another speculative tool call.",
  "- If the next call would only re-open paths you already read, write the report instead.",
  "- When the dispatch brief's done-definition is met, write the report envelope instead of making one more search or micro-edit.",
  "- Route file and web work through the dedicated tools, never run_shell — mining showed grok reaching for shell first when a typed tool already covered the job.",
  "- Never run git add, git commit, git stash, or any other state-changing git command unless the user asks.",
  "- Do not narrate a plan before acting on a small task; act, then report.",
  "- Verify with the test command once at the end, not after every edit.",
].join("\n");

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
      return {
        ...policy,
        applyGrokFinishBias: policy.applyGrokFinishBias && !orchestrator,
        advertisedToolDeny: orchestrator ? [] : policy.advertisedToolDeny,
        promptResidual: orchestrator ? undefined : policy.promptResidual,
      };
    }
    case "kimi":
      return {
        family,
        ...KIMI_POLICY,
        advertisedToolDeny: orchestrator ? [] : ["skill_search"],
      };
    case "muse":
      return { family, ...MUSE_POLICY };
    default:
      return { family: "default", ...DEFAULT_POLICY };
  }
}
