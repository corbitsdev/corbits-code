import {
  detectModelFamily,
  type ModelFamily,
} from "../subagent/provider-family.js";
import {
  astraResidual,
  claudeRow,
  gptRow,
  grokRow,
  grokToolBudgetResidual,
  museRow,
} from "../../packages/prompt-variance/src/index.js";

/**
 * Per-model-family tuning for the shared directors (main chat director and
 * SubAgentDirector). One policy object, resolved once per session from the
 * provider/model — directors stay generic and branch on data, never on
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
  /** Wall-clock inactivity, in ms, before a silent sub-agent is nudged. */
  subAgentStallTimeoutMs: number;
  /** Grok's finish-bias residual (withhold from orchestrators; see provider-family.ts). */
  applyGrokFinishBias: boolean;
  /**
   * Tool names to drop from the advertised wire prefix and the dispatch gate
   * (CL-7668). Empty by default. Orchestrators and leaves share the same
   * skill surface: both mount skill_search and use_skill. use_skill is never
   * denied.
   */
  advertisedToolDeny: readonly string[];
  /**
   * Tool-discipline rules appended to the system prompt for families that do
   * not self-terminate a tool loop. Empty for families that need none. Appended
   * at the tail so it cannot disturb the cached prompt prefix.
   */
  toolDisciplineRules?: string;
  /**
   * Provider-family residual appended once to the assembled sub-agent system
   * prompt (CL-8297). Tool-budget text for grok, the XML task_guidance block
   * for claude, the narrate-before-tools note for gpt (CL-8310, primary and
   * sub-agent alike).
   * Withheld from orchestrators and appended at the tail so it cannot
   * disturb the cached prompt prefix. Undefined for families that need none.
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
/** Default policy: permissive, no finish bias, no prompt residual. */
const DEFAULT_POLICY: Omit<ModelFamilyPolicy, "family"> = {
  toolOnlyTurnNudgeAt: 25,
  wrapUpNudgeText: DEFAULT_WRAP_UP_NUDGE_TEXT,
  subAgentStallTimeoutMs: 5 * 60_000,
  applyGrokFinishBias: false,
  advertisedToolDeny: [],
};

// Generic 4-line tool-budget residual (CL-8297). Grok sub-agents get this via
// promptResidual today; other families leave the seam unfilled until their
// own lanes land. Deliberately free of ceremony lines and family-specific
// routing — pure tool-loop budget. Source is grokToolBudgetResidual
// (prompt-variance CL-8269); the old name stays for existing importers.
export const GROK_TOOL_BUDGET_RESIDUAL = grokToolBudgetResidual;

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
  advertisedToolDeny: [],
  // Sub-agent value; the resolver clears it for orchestrators below.
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
// at the rungs where each wasted turn is most expensive. See CL-7869. Source is
// museRow.residual (prompt-variance CL-8269).
const MUSE_TOOL_DISCIPLINE_RULES = museRow.residual;

const MUSE_POLICY: Omit<ModelFamilyPolicy, "family"> = {
  ...DEFAULT_POLICY,
  toolDisciplineRules: MUSE_TOOL_DISCIPLINE_RULES,
};

// Single grok finish-bias + ceremony residual (CL-8296): the finish-bias
// bullets plus the three ceremony lines from the CL-7768 design (no git, no
// pre-plan, verify once), merged into one block with no line twice. The don't
// re-read idea appears exactly once (the "re-open paths" bullet) — it is not
// repeated. Grok-only: detectModelFamily has no glm family, so per the <30min
// rule no GLM row ships here. Source is grokRow.residual (prompt-variance
// CL-8269); the old name stays for existing importers. buildGrokLeafAntiThrashNote
// (prompts.ts) returns it verbatim so the prompt carries one copy. This is a
// different block from the CL-8297 tool-budget hook (GROK_TOOL_BUDGET_RESIDUAL,
// surfaced via the ModelFamilyPolicy.promptResidual field): grok sub-agents
// carry both, each once.
export const GROK_PROMPT_RESIDUAL = grokRow.residual;
// Claude (Anthropic) ships one XML residual, not prose: a prose residual did
// nothing, but a single <task_guidance> block cut Sonnet tokens. The block is
// the whole residual — never a full-prompt XML renderer. The text lives here
// (policy owns data); buildClaudeTaskGuidanceNote (prompts.ts) returns it
// verbatim so the prompt carries exactly one copy. Source is claudeRow.residual
// (prompt-variance CL-8269); the old name stays for existing importers.
export const CLAUDE_TASK_GUIDANCE_NOTE = claudeRow.residual;

const CLAUDE_POLICY: Omit<ModelFamilyPolicy, "family"> = {
  ...DEFAULT_POLICY,
  promptResidual: CLAUDE_TASK_GUIDANCE_NOTE,
};

// Tiny narrate-before-tools residual for GPT workers (CL-8310): GPT-5.5 runs
// showed 6–13 silent tool-only turns. Shared thrash harness + spawn contracts
// do the structural work; this is only a narrate-before-tools nudge.
// Deliberately not manage_tasks ceremony — that is CL-7769, not this text.
// The text lives here (policy owns data); buildGptNarrateBeforeToolsNote
// (prompts.ts) returns it verbatim so the prompt carries exactly one copy.
// Served cells (sol/terra/…) are never named here — CL-8265 characterizes
// them later. Astra is the one exception: forensics (CL-9027) showed the
// gpt-6-astra cell evading the shared threshold guard via trivial argument
// deltas, so it carries its own residual below. Source is gptRow.residual
// (prompt-variance CL-8269); the old name stays for existing importers.
export const GPT_NARRATE_BEFORE_TOOLS_NOTE = gptRow.residual;

// GPT (Codex / gpt-*) thresholds are provisional: we have no eval
// characterization yet for how GPT behaves under tool-only stretches or
// background-run stalls. Ship the permissive default rather than guessing at
// a tightened number; the narrate-before-tools residual is prompt-level (see
// GPT_NARRATE_BEFORE_TOOLS_NOTE above), not a threshold.
const GPT_POLICY: Omit<ModelFamilyPolicy, "family"> = {
  ...DEFAULT_POLICY,
  // Primary and sub-agent alike, so unlike the grok finish-bias there is no
  // orchestrator carve-out: the resolver below returns this as-is.
  promptResidual: GPT_NARRATE_BEFORE_TOOLS_NOTE,
};

// Astra (served gpt-6-astra cell) is GPT plus the evasion residual. Forensics
// on the repro trace (see model-family-policy.test.ts) classified the loop as
// evasion — near-identical re-issued calls whose trivial argument deltas keep
// every exact fingerprint under the shared threshold — so the residual forbids
// that specific variation (muse-rule precedent, CL-7869) instead of tightening
// thresholds: toolOnlyTurnNudgeAt stays at the permissive default. No
// signature normalization ships in first-party code.
export const ASTRA_PROMPT_RESIDUAL = `${GPT_NARRATE_BEFORE_TOOLS_NOTE}\n${astraResidual}`;

const ASTRA_POLICY: Omit<ModelFamilyPolicy, "family"> = {
  ...GPT_POLICY,
  // Like gpt, primary and sub-agent alike: no orchestrator carve-out.
  promptResidual: ASTRA_PROMPT_RESIDUAL,
};

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
      // The finish-bias residual only makes sense on sub-agents, mirroring
      // shouldApplyGrokAntiThrash: orchestrators dispatch other agents rather
      // than doing the work directly.
      return {
        ...policy,
        applyGrokFinishBias: policy.applyGrokFinishBias && !orchestrator,
        promptResidual: orchestrator ? undefined : policy.promptResidual,
      };
    }
    case "kimi":
      return {
        family,
        ...KIMI_POLICY,
      };
    case "muse":
      return { family, ...MUSE_POLICY };
    case "claude":
      // Like the grok finish-bias residual, the task_guidance block only makes
      // sense on sub-agents — orchestrators dispatch rather than doing the
      // work directly, so they resolve to the permissive default (no residual).
      return orchestrator
        ? { family, ...DEFAULT_POLICY }
        : { family, ...CLAUDE_POLICY };
    case "gpt":
      // Primary and sub-agent alike: no orchestrator carve-out.
      return { family, ...GPT_POLICY };
    case "astra":
      // Like gpt, primary and sub-agent alike: no orchestrator carve-out.
      // Generic gpt prompts are byte-identical — only astra carries the
      // residual.
      return { family, ...ASTRA_POLICY };
    default:
      return { family: "default", ...DEFAULT_POLICY };
  }
}
