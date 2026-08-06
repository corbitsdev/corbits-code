import type { ToolDefinition } from "@intx/types/runtime";
import { isKimiLeafProvider } from "../subagent/provider-family.js";

/** Context used to decide whether a provider needs wire-schema rewrites. */
export type NormalizeToolDefsContext = {
  providerName: string;
  model?: string;
};

/**
 * Non-recursive `present` parameters for Moonshot/kimi-class backends.
 * Those providers reject JSON Schema `$ref` cycles on `tools.function.parameters`
 * (recursive ViewNode). Runtime still validates full nested trees via
 * `validateView` — this only changes what we advertise on the wire.
 */
const KIMI_PRESENT_INPUT_SCHEMA = {
  type: "object",
  properties: {
    view: {
      type: "object",
      additionalProperties: true,
      description:
        "Root layout node as a freeform object tree (runtime validates structure). " +
        "Primitives: text{text, tone?, bold?, dim?}; " +
        "stack{children:[node], gap?:0|1}; row{children:[node], gap?:0|1}; " +
        "box{border?, padding?, children:[node]}; divider; " +
        "grid{columns?:[{align?}], rows: [ [cellNode, ...], ... ] }. " +
        "tone is one of default|muted|success|warning|danger|accent. " +
        "Compose freely rather than targeting named shapes.",
    },
  },
  required: ["view"],
} as const;

function rewritePresentForKimi(def: ToolDefinition): ToolDefinition {
  return {
    ...def,
    // structuredClone so callers cannot mutate the shared const via the tool def.
    inputSchema: structuredClone(KIMI_PRESENT_INPUT_SCHEMA) as ToolDefinition["inputSchema"],
  };
}

/**
 * Family-gated wire rewrite of tool definitions before they reach the director /
 * provider. Today only Moonshot/kimi get a non-recursive `present` schema;
 * other providers receive the definitions unchanged (identity).
 *
 * Does not alter runtime validation or the canonical `presentDefinition` used
 * as the source of truth for non-kimi advertise paths.
 */
export function normalizeToolDefinitionsForProvider(
  defs: readonly ToolDefinition[],
  ctx: NormalizeToolDefsContext,
): ToolDefinition[] {
  if (!isKimiLeafProvider(ctx)) {
    return defs as ToolDefinition[];
  }
  return defs.map((def) => (def.name === "present" ? rewritePresentForKimi(def) : def));
}
