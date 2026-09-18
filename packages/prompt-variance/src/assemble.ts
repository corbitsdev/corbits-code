import type { PromptVarianceRow } from "./rows.js";

export interface AssembledPromptVariance {
  systemPrompt: string;
  toolNames: readonly string[];
}

/**
 * Assemble a prompt from sections plus a family variance row (CL-8269).
 * The row residual renders last; advertised denies filter the mounted
 * tool names. Variance is subtractive only: the output names are always
 * a subset of the input names, in input order.
 */
export function assemble(
  sections: readonly string[],
  familyRow: PromptVarianceRow,
  tools: readonly string[],
): AssembledPromptVariance {
  if (familyRow.advertisedToolDeny.includes("use_skill")) {
    throw new Error(
      `prompt-variance: row "${familyRow.id}" denies use_skill — brief-named skills always load directly`,
    );
  }
  const systemPrompt =
    familyRow.residual.length > 0
      ? [...sections, familyRow.residual].join("\n\n")
      : sections.join("\n\n");
  const deny = new Set(familyRow.advertisedToolDeny);
  return {
    systemPrompt,
    toolNames: tools.filter((name) => !deny.has(name)),
  };
}
