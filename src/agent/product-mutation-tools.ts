/**
 * Single ownership set for product file-mutation tools.
 *
 * Primary deny, auto-allow, classify, thrash, and tool-preview all consume this
 * list so write_file / edit_file / delete_file / apply_patch cannot drift apart.
 * Proxy mounting is out of scope for this module.
 */

import {
  CodexApplyPatchError,
  extractAffectedPaths,
  parseCodexApplyPatch,
} from "./codex-apply-patch.js";

export const PRODUCT_MUTATION_TOOLS = [
  "write_file",
  "edit_file",
  "delete_file",
  "apply_patch",
] as const;

export type ProductMutationToolName = (typeof PRODUCT_MUTATION_TOOLS)[number];

const PRODUCT_MUTATION_TOOL_SET: ReadonlySet<string> = new Set(PRODUCT_MUTATION_TOOLS);

export function isProductMutationTool(name: string): boolean {
  return PRODUCT_MUTATION_TOOL_SET.has(name);
}

/**
 * Paths a product-mutation tool call would touch.
 * Path-arg tools use `path`; apply_patch parses envelope `input` when present.
 * Malformed / missing apply_patch input yields [] (subjects refine when a proxy mounts).
 */
export function productMutationPaths(name: string, args: unknown): string[] {
  if (!isProductMutationTool(name)) return [];
  const record =
    args !== null && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};

  if (name === "apply_patch") {
    const input = record.input;
    if (typeof input !== "string" || input.length === 0) return [];
    try {
      return extractAffectedPaths(parseCodexApplyPatch(input));
    } catch (err) {
      if (err instanceof CodexApplyPatchError) return [];
      throw err;
    }
  }

  const path = record.path;
  return typeof path === "string" && path.length > 0 ? [path] : [];
}
