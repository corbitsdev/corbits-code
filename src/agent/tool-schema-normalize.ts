import type { ToolDefinition } from "@intx/types/runtime";
import {
  isKimiLeafProvider,
  isMuseSparkLeafProvider,
  isXaiGrokLeafProvider,
} from "../subagent/provider-family.js";

/** Context used to decide whether a provider needs wire-schema rewrites. */
export interface NormalizeToolDefsContext {
  providerName: string;
  model?: string;
}

/**
 * Shared by the canonical `presentDefinition.description` and the acyclic
 * wire `view.description` so the two never drift.
 */
export const PRESENT_VIEW_PRIMITIVES_GUIDANCE =
  "Primitives: text{text, tone?, bold?, dim?}; " +
  "stack{children:[node], gap?:0|1}; row{children:[node], gap?:0|1}; " +
  "box{border?, padding?, children:[node]}; divider; " +
  "grid{columns?:[{align?}], rows: [ [cellNode, ...], ... ] } for aligned columns (cells are usually text nodes). " +
  "tone is one of default|muted|success|warning|danger|accent. " +
  "Compose freely rather than targeting named shapes.";

const TONE_ENUM = [
  "default",
  "muted",
  "success",
  "warning",
  "danger",
  "accent",
] as const;
const ALIGN_ENUM = ["left", "right", "center"] as const;
const GAP_ENUM = [0, 1] as const;

/** Leaf text node (no children). */
const TEXT_NODE = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["text"] },
    text: { type: "string" },
    tone: { type: "string", enum: [...TONE_ENUM] },
    bold: { type: "boolean" },
    dim: { type: "boolean" },
  },
  required: ["type", "text"],
  additionalProperties: false,
} as const;

/** Leaf divider node. */
const DIVIDER_NODE = {
  type: "object",
  properties: { type: { type: "string", enum: ["divider"] } },
  required: ["type"],
  additionalProperties: false,
} as const;

/**
 * Leafs fully typed; deeper containers use a depth-capped open object so
 * type/children/text/rows stay documented without recursive `$ref`.
 */
const NESTED_CHILD = {
  oneOf: [
    TEXT_NODE,
    DIVIDER_NODE,
    {
      type: "object",
      description:
        "Nested layout node (stack/row/box/grid or deeper). Runtime validates structure.",
      properties: {
        type: {
          type: "string",
          enum: ["stack", "row", "box", "grid", "text", "divider"],
        },
        text: { type: "string" },
        children: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
        rows: {
          type: "array",
          items: {
            type: "array",
            items: { type: "object", additionalProperties: true },
          },
        },
        gap: { type: "integer", enum: [...GAP_ENUM] },
        border: { type: "boolean" },
        padding: { type: "integer", enum: [...GAP_ENUM] },
        columns: {
          type: "array",
          items: {
            type: "object",
            properties: { align: { type: "string", enum: [...ALIGN_ENUM] } },
            additionalProperties: false,
          },
        },
        tone: { type: "string", enum: [...TONE_ENUM] },
        bold: { type: "boolean" },
        dim: { type: "boolean" },
      },
      required: ["type"],
      additionalProperties: true,
    },
  ],
} as const;

const COLUMNS_PROP = {
  type: "array",
  items: {
    type: "object",
    properties: { align: { type: "string", enum: [...ALIGN_ENUM] } },
    additionalProperties: false,
  },
} as const;

/**
 * Non-recursive `present` schema. Moonshot/Kimi and Muse Spark reject
 * `$ref` cycles on `tools.function.parameters` and fail the turn
 * before inference. Depth-capped oneOf keeps type/children/text
 * visible to the model; runtime still validates full nested trees via
 * `validateView`.
 */
export const KIMI_PRESENT_INPUT_SCHEMA = {
  type: "object",
  properties: {
    view: {
      description:
        "Root layout node. Runtime validates full nested trees. " +
        PRESENT_VIEW_PRIMITIVES_GUIDANCE,
      oneOf: [
        TEXT_NODE,
        DIVIDER_NODE,
        {
          type: "object",
          properties: {
            type: { type: "string", enum: ["stack"] },
            children: { type: "array", items: NESTED_CHILD },
            gap: { type: "integer", enum: [...GAP_ENUM] },
          },
          required: ["type", "children"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            type: { type: "string", enum: ["row"] },
            children: { type: "array", items: NESTED_CHILD },
            gap: { type: "integer", enum: [...GAP_ENUM] },
          },
          required: ["type", "children"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            type: { type: "string", enum: ["box"] },
            children: { type: "array", items: NESTED_CHILD },
            border: { type: "boolean" },
            padding: { type: "integer", enum: [...GAP_ENUM] },
          },
          required: ["type", "children"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            type: { type: "string", enum: ["grid"] },
            columns: COLUMNS_PROP,
            rows: {
              type: "array",
              items: { type: "array", items: NESTED_CHILD },
            },
          },
          required: ["type", "rows"],
          additionalProperties: false,
        },
      ],
    },
  },
  required: ["view"],
} as const;

function rewritePresentAcyclic(def: ToolDefinition): ToolDefinition {
  return {
    ...def,
    // structuredClone so callers cannot mutate the shared const via the def.
    inputSchema: structuredClone(
      KIMI_PRESENT_INPUT_SCHEMA,
    ) as ToolDefinition["inputSchema"],
  };
}

const OPEN_OBJECT = {
  type: "object",
  additionalProperties: true,
} as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function schemaDeclaresShape(node: Record<string, unknown>): boolean {
  return (
    node["type"] !== undefined ||
    node["$ref"] !== undefined ||
    node["oneOf"] !== undefined ||
    node["anyOf"] !== undefined ||
    node["allOf"] !== undefined
  );
}

function literalType(value: unknown): string | undefined {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
    case "object":
      return typeof value;
    default:
      return undefined;
  }
}

function withLiteralShape(
  node: Record<string, unknown>,
): Record<string, unknown> {
  if (schemaDeclaresShape(node)) return node;
  const values =
    "const" in node
      ? [node["const"]]
      : Array.isArray(node["enum"])
        ? node["enum"]
        : [];
  const types = [...new Set(values.map(literalType))].filter(
    (value): value is string => value !== undefined,
  );
  if (types.length === 0) return node;
  return types.length === 1
    ? { ...node, type: types[0] }
    : { ...node, anyOf: types.map((type) => ({ type })) };
}

const SCHEMA_MAP_KEYS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
  "dependencies",
]);
const SCHEMA_CHILD_KEYS = new Set([
  "items",
  "prefixItems",
  "additionalItems",
  "contains",
  "additionalProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "propertyNames",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "contentSchema",
]);

/**
 * Grok's Responses proxy 400s the whole infer on one invalid schema.
 * Untyped properties and `$schema` are the shapes MCP tools and
 * submit_result advertise.
 */
function sanitizeSchemaForGrok(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeSchemaForGrok);
  if (!isPlainObject(value)) return value;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "$schema" || key === "$id") continue;
    if (SCHEMA_MAP_KEYS.has(key) && isPlainObject(child)) {
      const props: Record<string, unknown> = {};
      for (const [name, prop] of Object.entries(child)) {
        const sanitized = sanitizeSchemaForGrok(prop);
        if (
          key === "properties" &&
          isPlainObject(sanitized) &&
          !schemaDeclaresShape(sanitized)
        ) {
          props[name] = { ...sanitized, ...OPEN_OBJECT };
        } else {
          props[name] = sanitized;
        }
      }
      next[key] = props;
      continue;
    }
    // Literal enum/const/default/example values can look like schemas;
    // only schema-valued keywords interpret their children.
    next[key] = SCHEMA_CHILD_KEYS.has(key)
      ? sanitizeSchemaForGrok(child)
      : child;
  }
  return withLiteralShape(next);
}

function sanitizeToolDefForGrok(def: ToolDefinition): ToolDefinition {
  return {
    ...def,
    inputSchema: sanitizeSchemaForGrok(
      structuredClone(def.inputSchema),
    ) as ToolDefinition["inputSchema"],
  };
}

function needsAcyclicPresentSchema(ctx: NormalizeToolDefsContext): boolean {
  return isKimiLeafProvider(ctx) || isMuseSparkLeafProvider(ctx);
}

/**
 * Family-gated wire rewrite of tool defs before they reach the
 * director / provider. Moonshot/kimi and Muse Spark get a non-recursive
 * `present` schema; Grok/xAI get schema sanitization; others pass through.
 * Does not alter runtime validation or the canonical `presentDefinition`.
 *
 * Call at every advertise path that may include `present`; sub-agent
 * toolsets omit it, so rewriting is a no-op unless one appears.
 */
export function normalizeToolDefinitionsForProvider(
  defs: readonly ToolDefinition[],
  ctx: NormalizeToolDefsContext,
): ToolDefinition[] {
  const acyclicPresent = needsAcyclicPresentSchema(ctx);
  const grok = isXaiGrokLeafProvider(ctx);
  if (!acyclicPresent && !grok) {
    return defs as ToolDefinition[];
  }
  return defs.map((def) => {
    let next = def;
    if (acyclicPresent && def.name === "present")
      next = rewritePresentAcyclic(next);
    if (grok) next = sanitizeToolDefForGrok(next);
    return next;
  });
}
