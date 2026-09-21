import {
  defaultRow,
  FAMILY_ROWS,
  type PromptVarianceFamily,
  type PromptVarianceRow,
} from "./rows.js";

/**
 * Resolve the variance row for a family, mirroring the leaves-only gates in
 * the model family policy: the grok finish-bias residual and the claude
 * task_guidance block only make sense on leaf workers, so orchestrators
 * fall back to the default row. Muse keeps its residual on both — the
 * constructors append the same text at the tail either way — and gpt keeps
 * its narrate-before-tools nudge on primaries and leaves alike.
 */
export function resolvePromptVariance(input: {
  family: PromptVarianceFamily;
  orchestrator?: boolean;
}): PromptVarianceRow {
  if (input.orchestrator === true) {
    if (input.family === "grok" || input.family === "claude") {
      return defaultRow;
    }
  }
  return FAMILY_ROWS[input.family];
}
