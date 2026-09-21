import type { PromptVarianceRow } from "./rows.js";

/**
 * Append a family variance row's residual at the tail of the assembled
 * sections (CL-8269). An empty residual leaves the sections unchanged.
 * Residuals render last so they cannot disturb the cached prompt prefix.
 * Tool mounting is out of scope: run.ts applies
 * ModelFamilyPolicy.advertisedToolDeny at mount time.
 */
export function assemble(
  sections: readonly string[],
  familyRow: PromptVarianceRow,
): string {
  if (familyRow.residual.length === 0) return sections.join("\n\n");
  return [...sections, familyRow.residual].join("\n\n");
}
