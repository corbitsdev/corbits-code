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

// Astra tool-evasion residual (CL-9027): forensics on the repro trace showed
// evasion, not waste — the gpt-6-astra leaf re-issues the same effective tool
// call with trivial argument deltas (path prefix, default offset/limit,
// padding whitespace), so no exact tool fingerprint repeats 3x and the shared
// threshold guard stays silent. This forbids that specific variation
// (muse-rule precedent, CL-7869); no signature normalization ships in
// first-party code. The re-read bullet is narrowed, not absolute (CL-9921):
// it discourages redundant unchanged re-read loops while permitting
// necessary re-reads (unread pages, changed content, targeted uncertainty
// resolution, compaction-lost evidence) with a stated reason and bounded
// scope. Named export rather than a family row: it travels the
// ModelFamilyPolicy.promptResidual seam, composed over the gpt narrate note.
export const astraResidual: string =
  "Tool discipline (gpt-6-astra worker):\n" +
  "- Never re-issue a tool call that repeats a prior call with only trivial argument changes (path prefix, offset, limit, whitespace).\n" +
  "- Avoid re-reading content you already have; do not loop full-file re-reads that add no new information.\n" +
  "- A re-read is permitted when it adds information: unread pages (a new offset/limit range), content that changed since the last read, a targeted re-read to resolve a specific uncertainty, or evidence lost to compaction.\n" +
  "- A necessary re-read states its reason and bounded scope first (path, range, and the question it answers) and does not restart a broad investigation.\n" +
  "- Boundary: the same path with default offset/limit after a full read is redundant; the same path with a new page range or after an edit is necessary.";
