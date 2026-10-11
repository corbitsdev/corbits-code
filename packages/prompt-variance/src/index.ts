export {
  claudeRow,
  defaultRow,
  FAMILY_IDS,
  FAMILY_ROWS,
  gptRow,
  grokRow,
  grokToolBudgetResidual,
  museRow,
  type PromptVarianceFamily,
  type PromptVarianceRow,
} from "./rows.js";

// Astra tool-evasion residual: the gpt-6-astra leaf re-issues the same
// effective tool call with trivial argument deltas (path prefix, default
// offset/limit, padding whitespace), so no exact fingerprint repeats and
// the shared threshold guard stays silent. This forbids that variation; no
// signature normalization ships in first-party code. Named export rather
// than a family row: it travels the ModelFamilyPolicy.promptResidual seam,
// composed over the gpt narrate note.
export const astraResidual: string =
  "Tool discipline (gpt-6-astra worker):\n" +
  "- Never re-issue a tool call that repeats a prior call with only trivial argument changes (path prefix, offset, limit, whitespace).\n" +
  "- Never re-read a file you have already read this session.";
