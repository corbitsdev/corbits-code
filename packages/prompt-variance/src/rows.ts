/**
 * Versioned model-family prompt variance (CL-8269). One row per tuned
 * family: a tail residual plus the tool names the family must not
 * advertise. Directors assemble prompts through `assemble`, never by
 * hand-concatenating family booleans.
 *
 * Only families with shipped eval numbers live here: default/muse/grok.
 * glm/claude/gpt rows land when CL-8265 / 7772 / 7775 characterize them.
 */

/** Families with a shipped variance row. */
export type PromptVarianceFamily = "default" | "muse" | "grok";

/** Residuals render at the tail so they cannot disturb the cached prefix. */
export type PromptVarianceRender = "tail";

export interface PromptVarianceRowOverride {
  residual?: string;
  advertisedToolDeny?: readonly string[];
  sectionOmit?: readonly string[];
}

export interface PromptVarianceRow {
  id: PromptVarianceFamily;
  render: PromptVarianceRender;
  /** Tail text appended to the assembled prompt. Empty when the family needs none. */
  residual: string;
  /**
   * Tool names to drop from the advertised set (CL-7668). Subtractive
   * only — a row can never grant a tool `assemble` was not given.
   * `use_skill` is never denied: brief-named skills load directly.
   */
  advertisedToolDeny: readonly string[];
  /** Assembly section ids to omit for this family. Empty until a family needs one. */
  sectionOmit: readonly string[];
  /** Optional per-model-id refinements, keyed by lowercase model id. */
  overrides?: Record<string, PromptVarianceRowOverride>;
}

export const FAMILY_IDS: readonly PromptVarianceFamily[] = [
  "default",
  "muse",
  "grok",
];

export const defaultRow: PromptVarianceRow = {
  id: "default",
  render: "tail",
  residual: "",
  advertisedToolDeny: [],
  sectionOmit: [],
};

// Muse Spark does not reliably stop a tool loop at medium reasoning effort:
// the same run with these three rules appended finished in 3 turns on 4.3x
// fewer input tokens (CL-7869). Byte-identical to the shipped text so the
// size table and the constructor append cannot drift apart.
export const museRow: PromptVarianceRow = {
  id: "muse",
  render: "tail",
  residual:
    "Tool discipline:\n" +
    "- Batch independent tool calls into a single turn.\n" +
    "- Never re-read a file you have already read this session.\n" +
    "- Do not narrate; act.",
  advertisedToolDeny: [],
  sectionOmit: [],
};

// Tiny residual for Grok/xAI workers: mining showed higher tools-only thrash
// than Codex on the same harness. Shared thrash harness + spawn contracts do
// the structural work; this is only a finish-bias nudge, not a full rewrite.
// Built from the current grok finish-bias text on origin/main; the CL-8297
// residual folds in here at merge time.
export const grokRow: PromptVarianceRow = {
  id: "grok",
  render: "tail",
  residual: [
    "Finish bias (xAI / Grok worker):",
    "- Once you can answer the dispatch brief, prefer the structured report over another speculative tool call.",
    "- If the next call would only re-open paths you already read, write the report instead.",
    "- When the dispatch brief's done-definition is met, write the report envelope instead of making one more search or micro-edit.",
    "- Route file and web work through the dedicated tools, never run_shell — mining showed grok reaching for shell first when a typed tool already covered the job.",
  ].join("\n"),
  // Leaf value; resolvePromptVariance clears it for orchestrators.
  advertisedToolDeny: ["skill_search"],
  sectionOmit: [],
};

export const FAMILY_ROWS: Record<PromptVarianceFamily, PromptVarianceRow> = {
  default: defaultRow,
  muse: museRow,
  grok: grokRow,
};
