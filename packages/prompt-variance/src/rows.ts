/**
 * Versioned model-family prompt variance (CL-8269). One row per tuned
 * family: the tail residual text directors append to the assembled prompt.
 * Residuals-only: the package owns residual TEXT, never tool mounting —
 * advertisedToolDeny stays on ModelFamilyPolicy
 * (src/agent/model-family-policy.ts) and is empty on every family today.
 * Keeping deny out of this package removes the duplicate-deny footgun.
 *
 * Families ship here as their lanes characterize them: default/muse/grok
 * first, claude (CL-8309) and gpt (CL-8310) folded in on the P5 rebase.
 * Render position is always the tail so residuals cannot disturb the
 * cached prompt prefix.
 */

/** Families with a shipped variance row. */
export type PromptVarianceFamily =
  | "default"
  | "muse"
  | "grok"
  | "claude"
  | "gpt";

export interface PromptVarianceRow {
  id: PromptVarianceFamily;
  /** Tail text appended to the assembled prompt. Empty when the family needs none. */
  residual: string;
}

export const FAMILY_IDS: readonly PromptVarianceFamily[] = [
  "default",
  "muse",
  "grok",
  "claude",
  "gpt",
];

export const defaultRow: PromptVarianceRow = {
  id: "default",
  residual: "",
};

// Muse Spark does not reliably stop a tool loop at medium reasoning effort:
// the same run with these three rules appended finished in 3 turns on 4.3x
// fewer input tokens (CL-7869). Byte-identical to the shipped text so the
// size table and the constructor append cannot drift apart.
export const museRow: PromptVarianceRow = {
  id: "muse",
  residual:
    "Tool discipline:\n" +
    "- Batch independent tool calls into a single turn.\n" +
    "- Never re-read a file you have already read this session.\n" +
    "- Do not narrate; act.",
};

// Single grok finish-bias + ceremony residual (CL-8296): the finish-bias
// bullets plus the three ceremony lines from the CL-7768 design (no git, no
// pre-plan, verify once), merged into one block with no line twice. The
// don't re-read idea appears exactly once (the "re-open paths" bullet).
// Grok-only: detectModelFamily has no glm family, so no GLM row ships here.
export const grokRow: PromptVarianceRow = {
  id: "grok",
  residual: [
    "Finish bias (xAI / Grok worker):",
    "- Once you can answer the dispatch brief, prefer the structured report over another speculative tool call.",
    "- If the next call would only re-open paths you already read, write the report instead.",
    "- When the dispatch brief's done-definition is met, write the report envelope instead of making one more search or micro-edit.",
    "- Route file and web work through the dedicated tools, never bash — mining showed grok reaching for shell first when a typed tool already covered the job.",
    "- Never run git add, git commit, git stash, or any other state-changing git command unless the user asks.",
    "- Do not narrate a plan before acting on a small task; act, then report.",
    "- Verify with the test command once at the end, not after every edit.",
  ].join("\n"),
};

// Grok tool-budget hook (CL-8297): pure tool-loop budget, deliberately free
// of ceremony lines and family-specific routing. Grok leaves carry this via
// the ModelFamilyPolicy.promptResidual field alongside the grokRow block
// above (the finish-bias note) — each once. A named export rather than a
// family row because it travels a different seam (promptResidual field,
// not the finish-bias note).
export const grokToolBudgetResidual: string =
  "Tool budget:\n" +
  "- Batch independent tool calls into a single turn.\n" +
  "- Never re-issue a tool call whose result you already have.\n" +
  "- When the next call would only repeat prior work, write the report instead.";

// Single XML residual for Claude-family workers (CL-8309): a prose residual
// did nothing, but one <task_guidance> block cut Sonnet tokens. The block is
// the whole residual — never a full-prompt XML renderer, never applied
// outside the claude family. Rebuilt end to end from Anthropic's prompting
// docs: rationale first, numbered approach, named output contract.
export const claudeRow: PromptVarianceRow = {
  id: "claude",
  residual: [
    "<task_guidance>",
    "Autonomous coding turn: finish the work in this turn on your best judgment.",
    "1. Follow the dispatch brief exactly; its Success criteria are the done-definition.",
    "2. Batch independent tool calls into a single turn; work from files already read this session.",
    "3. Finish the task when the done-definition is met: prefer the structured report envelope over another tool call.",
    "</task_guidance>",
  ].join("\n"),
};

// Tiny narrate-before-tools residual for GPT workers (CL-8310): GPT-5.5 runs
// showed 6–13 silent tool-only turns. Shared thrash harness + spawn contracts
// do the structural work; this is only a narrate-before-tools nudge.
// Deliberately not manage_tasks ceremony — that is CL-7769, not this text.
export const gptRow: PromptVarianceRow = {
  id: "gpt",
  residual: [
    "Narrate before tools (GPT worker):",
    "- Before each tool call, write one short line saying what you are doing and why.",
    "- Never make back-to-back tool calls with no narration between them.",
    "- When the dispatch brief's done-definition is met, write the report envelope instead of making another tool call.",
  ].join("\n"),
};

export const FAMILY_ROWS: Record<PromptVarianceFamily, PromptVarianceRow> = {
  default: defaultRow,
  muse: museRow,
  grok: grokRow,
  claude: claudeRow,
  gpt: gptRow,
};
