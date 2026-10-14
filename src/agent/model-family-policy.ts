import {
  detectModelFamily,
  type ModelFamily,
} from "../subagent/provider-family.js";
import {
  astraResidual,
  claudeRow,
  dsv4CoderBodyRow,
  dsv4LeafRow,
  dsv4PrimaryRow,
  dsv4ReviewerBodyRow,
  gptRow,
  grokRow,
  museRow,
} from "../../packages/prompt-variance/src/index.js";

/**
 * Per-model-family tuning for the shared directors. One policy object
 * resolved per session/leaf from the provider/model.
 */
export interface ModelFamilyPolicy {
  family: ModelFamily;
  /**
   * Consecutive tool-only turns (tool calls, no text) before the main chat
   * director injects a one-shot wrap-up nudge. Soft check-in, never a pause.
   */
  toolOnlyTurnNudgeAt: number;
  /** Ephemeral nudge text injected at toolOnlyTurnNudgeAt. */
  wrapUpNudgeText: string;
  /** Wall-clock inactivity, in ms, before a silent sub-agent is nudged. */
  subAgentStallTimeoutMs: number;
  /** Grok's finish-bias residual (withhold from orchestrators; see provider-family.ts). */
  applyGrokFinishBias: boolean;
  /**
   * Tool names dropped from the advertised wire prefix and the dispatch gate.
   * Empty by default; use_skill is never denied.
   */
  advertisedToolDeny: readonly string[];
  /**
   * Tool-discipline rules appended to the system prompt for families that do
   * not self-terminate a tool loop. Appended at the tail to keep the cached
   * prompt prefix intact.
   */
  toolDisciplineRules?: string;
  /**
   * Provider-family residual appended once to the leaf system prompt
   * (tool-budget text for grok, XML task_guidance for claude, narrate
   * note for gpt). Withheld from orchestrators; appended at the tail.
   */
  promptResidual?: string | undefined;
  /**
   * Replaces the director body (formatDirectorSystemPrompt) on a leaf worker
   * for families with a tuned slim body for that role. Undefined keeps the
   * shared director body. run.ts feeds it into the extensions list in place
   * of the stock director body.
   */
  leafRoleBody?: string | undefined;
}

const DEFAULT_WRAP_UP_NUDGE_TEXT =
  "You have made several consecutive tool calls without any explanation. " +
  "Stop and summarize what you have done so far and what remains, or continue " +
  "if genuinely mid-task — but say so.";

const GROK_WRAP_UP_NUDGE_TEXT =
  "You are running long stretches of tool calls with no narration. Stop and " +
  "report progress now: what you have done, what is left, and whether you are " +
  "actually still making progress.";

// Real-session forensics found healthy tool-only streaks topping out at 28
// turns, so 25 sits above that ceiling; erring high costs nothing.
/** Default policy: permissive, no finish bias, no prompt residual. */
const DEFAULT_POLICY: Omit<ModelFamilyPolicy, "family"> = {
  toolOnlyTurnNudgeAt: 25,
  wrapUpNudgeText: DEFAULT_WRAP_UP_NUDGE_TEXT,
  subAgentStallTimeoutMs: 5 * 60_000,
  applyGrokFinishBias: false,
  advertisedToolDeny: [],
};

// Grok carries ONE tool-discipline residual (the merged tool-budget +
// finish-bias row from prompt-variance). No second block, no double append.
export const GROK_TOOL_BUDGET_RESIDUAL = grokRow.residual;

// Grok keeps its own nudge copy but shares the default stall timeout:
// workbench fleets show routine 60–180s thinking gaps, so a shorter kill
// would false-positive salvage mid-inference.
const GROK_POLICY: Omit<ModelFamilyPolicy, "family"> = {
  toolOnlyTurnNudgeAt: DEFAULT_POLICY.toolOnlyTurnNudgeAt,
  wrapUpNudgeText: GROK_WRAP_UP_NUDGE_TEXT,
  subAgentStallTimeoutMs: DEFAULT_POLICY.subAgentStallTimeoutMs,
  applyGrokFinishBias: true,
  advertisedToolDeny: [],
  // Sub-agent value; the resolver clears it for orchestrators below.
  promptResidual: GROK_TOOL_BUDGET_RESIDUAL,
};

// Kimi thresholds are provisional: no eval data yet. Ship the permissive
// default; revisit once data exists.
const KIMI_POLICY: Omit<ModelFamilyPolicy, "family"> = { ...DEFAULT_POLICY };

// Muse Spark does not reliably stop a tool loop at medium reasoning effort:
// re-reads ran out the 8-turn ceiling; with these three rules the same run
// finished in 3 turns on 4.3x fewer tokens — and medium effort is exactly
// where a wasted turn is most expensive. Single-sourced from prompt-variance.
const MUSE_TOOL_DISCIPLINE_RULES = museRow.residual;

const MUSE_POLICY: Omit<ModelFamilyPolicy, "family"> = {
  ...DEFAULT_POLICY,
  toolDisciplineRules: MUSE_TOOL_DISCIPLINE_RULES,
};

// Grok residual alias — ONE merged block now (the tool-budget/finish-bias
// row). GROK_TOOL_BUDGET_RESIDUAL and GROK_PROMPT_RESIDUAL are the same text;
// the double-append seam in prompts.ts is retired.
export const GROK_PROMPT_RESIDUAL = grokRow.residual;
// Claude ships one XML residual, not prose: a single <task_guidance> block
// cut Sonnet tokens where prose did nothing. The block is the whole residual.
export const CLAUDE_TASK_GUIDANCE_NOTE = claudeRow.residual;

const CLAUDE_POLICY: Omit<ModelFamilyPolicy, "family"> = {
  ...DEFAULT_POLICY,
  promptResidual: CLAUDE_TASK_GUIDANCE_NOTE,
};

// Narrate-before-tools residual for GPT workers: GPT-5.5 runs showed 6–13
// silent tool-only turns. A nudge only, not manage_tasks ceremony. Astra is
// the one exception — it evades the shared threshold guard via trivial
// argument deltas, so it carries its own residual below.
export const GPT_NARRATE_BEFORE_TOOLS_NOTE = gptRow.residual;

// GPT thresholds are provisional: no eval data yet. Ship the permissive
// default; the residual is prompt-level, not a threshold.
const GPT_POLICY: Omit<ModelFamilyPolicy, "family"> = {
  ...DEFAULT_POLICY,
  // Primary and leaf alike: no orchestrator carve-out.
  promptResidual: GPT_NARRATE_BEFORE_TOOLS_NOTE,
};

// Astra (gpt-6-astra cell) is GPT plus an evasion residual: the repro trace
// looped via trivial argument deltas that keep exact fingerprints under the
// shared threshold, so the residual forbids that variation instead of
// tightening thresholds.
export const ASTRA_PROMPT_RESIDUAL = `${GPT_NARRATE_BEFORE_TOOLS_NOTE}\n${astraResidual}`;

const ASTRA_POLICY: Omit<ModelFamilyPolicy, "family"> = {
  ...GPT_POLICY,
  // Like gpt, primary and sub-agent alike: no orchestrator carve-out.
  promptResidual: ASTRA_PROMPT_RESIDUAL,
};

// DeepSeek V4 d1+slim rows live in the prompt-variance package now
// (packages/prompt-variance/src/dsv4.ts): one home for family residual TEXT.
// The winning d1+slim config is unchanged; the second identity authority
// ("Identity: agent id ...") is gone — the leaf role bodies compose under the
// single identity header at the run seam.
export const DSV4_D1_PRIMARY_RESIDUAL = dsv4PrimaryRow.residual;

export const DSV4_BODY_CODER = dsv4CoderBodyRow.residual;

export const DSV4_BODY_REVIEWER = dsv4ReviewerBodyRow.residual;
export const DSV4_G2_LEAF_RESIDUAL = dsv4LeafRow.residual;

export function resolveModelFamilyPolicy(input: {
  providerName: string;
  model?: string;
  orchestrator?: boolean;
  /** Leaf director id (coder, reviewer, explorer, …) for role-tuned families. */
  directorId?: string;
}): ModelFamilyPolicy {
  const family = detectModelFamily(input);
  const orchestrator = input.orchestrator === true;
  switch (family) {
    case "grok": {
      const policy = { family, ...GROK_POLICY };
      // Finish-bias residual only makes sense on leaf workers; orchestrators
      // dispatch other agents rather than doing the work directly.
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
      // Like grok's finish-bias, task_guidance only makes sense on leaf
      // workers — orchestrators get the permissive default.
      return orchestrator
        ? { family, ...DEFAULT_POLICY }
        : { family, ...CLAUDE_POLICY };
    case "gpt":
      // Primary and sub-agent alike: no orchestrator carve-out.
      return { family, ...GPT_POLICY };
    case "astra":
      // Like gpt: no orchestrator carve-out; only astra carries the residual.
      return { family, ...ASTRA_POLICY };
    case "deepseek": {
      // Winning d1+slim config: d1 primary residual on orchestrators, g2 leaf
      // residual on explorer leaves, tuned slim coder/reviewer bodies.
      const directorId = input.directorId;
      return {
        family,
        ...DEFAULT_POLICY,
        promptResidual: orchestrator
          ? DSV4_D1_PRIMARY_RESIDUAL
          : directorId === "explorer"
            ? DSV4_G2_LEAF_RESIDUAL
            : undefined,
        leafRoleBody:
          !orchestrator && directorId === "coder"
            ? DSV4_BODY_CODER
            : !orchestrator && directorId === "reviewer"
              ? DSV4_BODY_REVIEWER
              : undefined,
      };
    }
    default:
      return { family: "default", ...DEFAULT_POLICY };
  }
}
