import { defined } from "../../testkit/defined.js";
import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@intx/types/runtime";
import { presentDefinition } from "./director.js";
import { manageTasksDefinition } from "./tasks.js";
import {
  KIMI_PRESENT_INPUT_SCHEMA,
  normalizeToolDefinitionsForProvider,
  PRESENT_VIEW_PRIMITIVES_GUIDANCE,
} from "./tool-schema-normalize.js";
import { validateView } from "../tui/view/validate.js";

/** True when any object in the schema tree carries a `$ref` key. */
function schemaHasRef(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(schemaHasRef);
  const obj = value as Record<string, unknown>;
  if ("$ref" in obj) return true;
  return Object.values(obj).some(schemaHasRef);
}

/** True when schema defines `$defs` (typical home of recursive ViewNode). */
function schemaHasDefs(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(schemaHasDefs);
  const obj = value as Record<string, unknown>;
  if ("$defs" in obj) return true;
  return Object.values(obj).some(schemaHasDefs);
}

const recursivePresent = presentDefinition;
const otherTool = manageTasksDefinition;
const defs = [recursivePresent, otherTool];

describe("normalizeToolDefinitionsForProvider", () => {
  test("canonical present schema is recursive ($ref / $defs)", () => {
    // Documents the bug: Moonshot rejects this shape on the wire.
    expect(schemaHasRef(recursivePresent.inputSchema)).toBe(true);
    expect(schemaHasDefs(recursivePresent.inputSchema)).toBe(true);
  });

  test("present description and kimi view description share primitives guidance (no dual prose drift)", () => {
    expect(PRESENT_VIEW_PRIMITIVES_GUIDANCE.length).toBeGreaterThan(0);
    expect(presentDefinition.description).toContain(
      PRESENT_VIEW_PRIMITIVES_GUIDANCE,
    );
    const viewDesc = (
      KIMI_PRESENT_INPUT_SCHEMA.properties.view as { description: string }
    ).description;
    expect(viewDesc).toContain(PRESENT_VIEW_PRIMITIVES_GUIDANCE);
  });

  test("kimi / moonshot present wire schema has no $ref cycle", () => {
    const out = normalizeToolDefinitionsForProvider(defs, {
      providerName: "moonshot",
      model: "kimi-k2",
    });
    const present = out.find((d) => d.name === "present");
    expect(present).toBeDefined();
    expect(schemaHasRef(defined(present).inputSchema)).toBe(false);
    expect(schemaHasDefs(defined(present).inputSchema)).toBe(false);
    const schema = defined(present).inputSchema as {
      type?: string;
      required?: string[];
      properties?: {
        view?: {
          oneOf?: unknown[];
          description?: string;
        };
      };
    };
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["view"]);
    // Richer non-recursive shape: view is oneOf of primitives, not bare freeform.
    expect(Array.isArray(schema.properties?.view?.oneOf)).toBe(true);
    expect(
      (schema.properties?.view?.oneOf ?? []).length,
    ).toBeGreaterThanOrEqual(4);
    expect(schema.properties?.view?.description).toContain("Primitives:");
    // Description + examples stay on the tool for model guidance.
    expect(defined(present).description).toBe(recursivePresent.description);
    expect(defined(present).description.length).toBeGreaterThan(0);
  });

  test("kimi advertise payload is the exact Moonshot wire shape (pinned fixture, no live Moonshot)", () => {
    // The advertise payload Moonshot receives for tools.function.parameters
    // on `present` after normalizeToolDefinitionsForProvider — recorded so
    // the contract cannot drift without a deliberate fixture update.
    const out = normalizeToolDefinitionsForProvider(defs, {
      providerName: "moonshot",
      model: "kimi-k2",
    });
    const present = defined(out.find((d) => d.name === "present"));
    expect(present.inputSchema).toEqual(
      structuredClone(KIMI_PRESENT_INPUT_SCHEMA) as typeof present.inputSchema,
    );
    // Stable JSON pin of the full wire schema object.
    expect(JSON.stringify(present.inputSchema)).toBe(
      JSON.stringify(KIMI_PRESENT_INPUT_SCHEMA),
    );
  });

  test("opencode-go + kimi-k3 rewrites present (model-id gate)", () => {
    const out = normalizeToolDefinitionsForProvider(defs, {
      providerName: "opencode-go",
      model: "kimi-k3",
    });
    const present = defined(out.find((d) => d.name === "present"));
    expect(schemaHasRef(present.inputSchema)).toBe(false);
    expect(schemaHasDefs(present.inputSchema)).toBe(false);
  });

  test("openai-compat + kimi model rewrites present", () => {
    const out = normalizeToolDefinitionsForProvider(defs, {
      providerName: "openai-compat",
      model: "kimi-k3",
    });
    expect(
      schemaHasRef(defined(out.find((d) => d.name === "present")).inputSchema),
    ).toBe(false);
  });

  // Meta Muse Spark (OpenCode Go / Zen) rejects recursive $ref cycles with
  // "Recursive JSON schemas are not currently supported". Same wire rewrite
  // as Kimi — model-id gate via isMuseSparkLeafProvider.
  test.each([
    {
      providerName: "opencode-go",
      model: "muse-spark-1.3-contributor",
    },
    {
      providerName: "opencode-go",
      model: "muse-spark-1.2-contributor",
    },
    { providerName: "opencode-go", model: "muse-spark-1.3" },
    { providerName: "zen", model: "muse-spark-1.3-contributor-free" },
  ] as const)(
    "$providerName + $model rewrites present (muse schema gate)",
    (ctx) => {
      const out = normalizeToolDefinitionsForProvider(defs, ctx);
      const present = defined(out.find((d) => d.name === "present"));
      expect(schemaHasRef(present.inputSchema)).toBe(false);
      expect(schemaHasDefs(present.inputSchema)).toBe(false);
      expect(present.inputSchema).toEqual(
        structuredClone(
          KIMI_PRESENT_INPUT_SCHEMA,
        ) as typeof present.inputSchema,
      );
    },
  );

  test("providers that accept recursive schemas get identity present", () => {
    for (const ctx of [
      { providerName: "anthropic", model: "claude-sonnet-4" },
      { providerName: "openai", model: "gpt-5.6" },
      { providerName: "opencode-go", model: "gpt-5.1" },
    ] as const) {
      const out = normalizeToolDefinitionsForProvider(defs, ctx);
      expect(out).toBe(defs);
      const present = defined(out.find((d) => d.name === "present"));
      expect(schemaHasRef(present.inputSchema)).toBe(true);
      expect(present.inputSchema).toBe(recursivePresent.inputSchema);
    }
  });

  test("grok sanitizes untyped properties and strips $schema", () => {
    const untyped: ToolDefinition = {
      name: "submit_result",
      description: "test",
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          turn_token: { type: "string" },
          result: { description: "The structured result payload." },
        },
        required: ["turn_token", "result"],
      },
    };
    const out = normalizeToolDefinitionsForProvider([untyped], {
      providerName: "xai/default-2",
      model: "grok-4.6",
    });
    const schema = defined(out[0]).inputSchema as {
      $schema?: unknown;
      properties?: {
        result?: { type?: string; additionalProperties?: boolean };
      };
    };
    expect(schema.$schema).toBeUndefined();
    expect(schema.properties?.result?.type).toBe("object");
    expect(schema.properties?.result?.additionalProperties).toBe(true);
  });

  test("grok sanitizer leaves anthropic identity and typed properties alone", () => {
    const typed: ToolDefinition = {
      name: "ask_director",
      description: "test",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string", description: "q" },
        },
        required: ["question"],
      },
    };
    const input = [typed];
    const grok = normalizeToolDefinitionsForProvider(input, {
      providerName: "xai/default",
      model: "grok-4.6",
    });
    const anthropic = normalizeToolDefinitionsForProvider(input, {
      providerName: "anthropic",
      model: "claude-sonnet-4",
    });
    expect(anthropic).toBe(input);
    expect(grok).not.toBe(input);
    const grokQuestion = (
      defined(grok[0]).inputSchema as {
        properties?: { question?: { type?: string } };
      }
    ).properties?.question;
    expect(grokQuestion?.type).toBe("string");
  });

  test.each([
    { values: ["open", "closed"], types: ["string"] },
    { values: [1, 2.5], types: ["number"] },
    { values: [true, false], types: ["boolean"] },
    { values: [null], types: ["null"] },
    { values: [[1], [2]], types: ["array"] },
    { values: [{ state: "open" }], types: ["object"] },
    {
      values: ["open", null, 1, true, [], {}],
      types: ["string", "null", "number", "boolean", "array", "object"],
    },
  ])("grok preserves enum values with types $types", ({ values, types }) => {
    const def: ToolDefinition = {
      name: "mcp__tracker__set_state",
      description: "Set state",
      inputSchema: {
        type: "object",
        properties: { state: { enum: values } },
        required: ["state"],
      },
    };
    const before = structuredClone(def);
    const normalized = defined(
      normalizeToolDefinitionsForProvider([def], {
        providerName: "xai/default",
        model: "grok-4.6",
      })[0],
    );
    const schema = normalized.inputSchema as {
      properties: {
        state: {
          enum: unknown[];
          type?: string;
          anyOf?: { type: string }[];
        };
      };
    };
    const state = schema.properties.state;
    expect(state.enum).toEqual([...values]);
    expect(state.anyOf?.map((branch) => branch.type) ?? [state.type]).toEqual([
      ...types,
    ]);
    expect(def).toEqual(before);
    expect(
      normalizeToolDefinitionsForProvider([def], {
        providerName: "anthropic",
        model: "claude-sonnet-4",
      })[0],
    ).toBe(def);
  });

  test.each([
    { value: "open", expectedType: "string" },
    { value: 1.5, expectedType: "number" },
    { value: true, expectedType: "boolean" },
    { value: null, expectedType: "null" },
    { value: ["open"], expectedType: "array" },
    { value: { state: "open" }, expectedType: "object" },
  ])(
    "grok preserves $expectedType const payloads",
    ({ value, expectedType }) => {
      const def: ToolDefinition = {
        name: "mcp__tracker__set_state",
        description: "Set state",
        inputSchema: {
          type: "object",
          properties: { state: { const: value } },
          required: ["state"],
        },
      };
      const before = structuredClone(def);
      const normalized = defined(
        normalizeToolDefinitionsForProvider([def], {
          providerName: "xai/default",
          model: "grok-4.6",
        })[0],
      );
      expect(normalized.inputSchema).toMatchObject({
        properties: { state: { const: value, type: expectedType } },
      });
      expect(def).toEqual(before);
    },
  );

  test("grok sanitizes schema nodes without rewriting literal payloads or property names", () => {
    const literal = {
      $schema: "literal schema value",
      $id: "literal id value",
      properties: { payload: { description: "literal, not a schema" } },
    };
    const def: ToolDefinition = {
      name: "mcp__schema__save",
      description: "Save a schema document",
      inputSchema: {
        type: "object",
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "https://example.invalid/tool",
        properties: {
          $schema: { type: "string" },
          $id: { type: "string" },
          document: {
            enum: [literal],
            const: literal,
            default: literal,
            examples: [literal],
          },
          entries: {
            type: "array",
            items: {
              $id: "https://example.invalid/entry",
              type: "object",
              properties: { payload: { description: "untyped payload" } },
            },
          },
        },
        $defs: {
          $schema: {
            type: "object",
            properties: { payload: { description: "untyped definition" } },
          },
        },
      },
    };
    const before = structuredClone(def);
    const normalized = defined(
      normalizeToolDefinitionsForProvider([def], {
        providerName: "xai/default",
        model: "grok-4.6",
      })[0],
    );
    expect(normalized.inputSchema).toMatchObject({
      properties: {
        $schema: { type: "string" },
        $id: { type: "string" },
        document: {
          enum: [literal],
          const: literal,
          default: literal,
          examples: [literal],
        },
        entries: {
          items: {
            properties: {
              payload: { type: "object", additionalProperties: true },
            },
          },
        },
      },
      $defs: {
        $schema: {
          properties: {
            payload: { type: "object", additionalProperties: true },
          },
        },
      },
    });
    const schema = normalized.inputSchema as {
      $schema?: unknown;
      $id?: unknown;
      properties: { entries: { items: { $id?: unknown } } };
    };
    expect(schema.$schema).toBeUndefined();
    expect(schema.$id).toBeUndefined();
    expect(schema.properties.entries.items.$id).toBeUndefined();
    expect(def).toEqual(before);
  });

  test("kimi rewrite leaves non-present tools untouched", () => {
    const out = normalizeToolDefinitionsForProvider(defs, {
      providerName: "moonshot",
    });
    const tasks = out.find((d) => d.name === "manage_tasks");
    expect(tasks).toBe(otherTool);
  });

  test("nested view trees still validate at runtime (independent of wire schema)", () => {
    const nested = {
      type: "stack",
      children: [
        { type: "text", text: "Build", bold: true },
        {
          type: "row",
          gap: 1,
          children: [
            { type: "text", text: "status:" },
            { type: "text", text: "ok", tone: "success" },
          ],
        },
        {
          type: "box",
          border: true,
          children: [
            {
              type: "grid",
              columns: [{ align: "left" }, { align: "right" }],
              rows: [
                [
                  { type: "text", text: "Name", bold: true },
                  { type: "text", text: "Count", bold: true },
                ],
                [
                  { type: "text", text: "Alpha" },
                  { type: "text", text: "3" },
                ],
              ],
            },
          ],
        },
      ],
    };
    const r = validateView(nested);
    expect(r.ok).toBe(true);
  });
});
