import {
  defaultRow,
  FAMILY_ROWS,
  type PromptVarianceFamily,
  type PromptVarianceRow,
} from "./rows.js";

/**
 * Apply a row's per-model-id override, if any. Model ids match
 * case-insensitively against the row's lowercase override keys; an
 * unknown id resolves to the base row unchanged.
 */
export function applyRowOverride(
  row: PromptVarianceRow,
  model?: string,
): PromptVarianceRow {
  if (model === undefined) return row;
  const override = row.overrides?.[model.trim().toLowerCase()];
  if (override === undefined) return row;
  return {
    ...row,
    residual: override.residual ?? row.residual,
    advertisedToolDeny: override.advertisedToolDeny ?? row.advertisedToolDeny,
    sectionOmit: override.sectionOmit ?? row.sectionOmit,
  };
}

/**
 * Resolve the variance row for a family, mirroring the leaves-only gate:
 * the grok finish-bias residual only makes sense on leaf workers, so
 * orchestrators fall back to the default shape. Muse keeps its residual
 * on both — its constructors append the same text at the tail either way.
 */
export function resolvePromptVariance(input: {
  family: PromptVarianceFamily;
  orchestrator?: boolean;
  model?: string;
}): PromptVarianceRow {
  if (input.family === "grok" && input.orchestrator === true) {
    return applyRowOverride(defaultRow, input.model);
  }
  return applyRowOverride(FAMILY_ROWS[input.family], input.model);
}
