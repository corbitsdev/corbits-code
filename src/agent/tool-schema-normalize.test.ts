import { describe, expect, test } from "bun:test";
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
    expect(presentDefinition.description).toContain(PRESENT_VIEW_PRIMITIVES_GUIDANCE);
    const viewDesc = (KIMI_PRESENT_INPUT_SCHEMA.properties.view as { description: string })
      .description;
    expect(viewDesc).toContain(PRESENT_VIEW_PRIMITIVES_GUIDANCE);
  });

  test("kimi / moonshot present wire schema has no $ref cycle", () => {
    const out = normalizeToolDefinitionsForProvider(defs, {
      providerName: "moonshot",
      model: "kimi-k2",
    });
    const present = out.find((d) => d.name === "present");
    expect(present).toBeDefined();
    expect(schemaHasRef(present!.inputSchema)).toBe(false);
    expect(schemaHasDefs(present!.inputSchema)).toBe(false);
    const schema = present!.inputSchema as {
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
    expect((schema.properties?.view?.oneOf ?? []).length).toBeGreaterThanOrEqual(4);
    expect(schema.properties?.view?.description).toContain("Primitives:");
    // Description + examples stay on the tool for model guidance.
    expect(present!.description).toBe(recursivePresent.description);
    expect(present!.description.length).toBeGreaterThan(0);
  });

  test("kimi advertise payload is the exact Moonshot wire shape (pinned fixture, no live Moonshot)", () => {
    // This is the advertise payload Moonshot receives for tools.function.parameters
    // on `present` after normalizeToolDefinitionsForProvider — recorded so the
    // contract cannot drift without a deliberate fixture update.
    const out = normalizeToolDefinitionsForProvider(defs, {
      providerName: "moonshot",
      model: "kimi-k2",
    });
    const present = out.find((d) => d.name === "present")!;
    expect(present.inputSchema).toEqual(
      structuredClone(KIMI_PRESENT_INPUT_SCHEMA) as typeof present.inputSchema,
    );
    // Stable JSON pin of the full wire schema object.
    expect(JSON.stringify(present.inputSchema)).toBe(JSON.stringify(KIMI_PRESENT_INPUT_SCHEMA));
  });

  test("opencode-go + kimi-k3 rewrites present (model-id gate)", () => {
    const out = normalizeToolDefinitionsForProvider(defs, {
      providerName: "opencode-go",
      model: "kimi-k3",
    });
    const present = out.find((d) => d.name === "present")!;
    expect(schemaHasRef(present.inputSchema)).toBe(false);
    expect(schemaHasDefs(present.inputSchema)).toBe(false);
  });

  test("openai-compat + kimi model rewrites present", () => {
    const out = normalizeToolDefinitionsForProvider(defs, {
      providerName: "openai-compat",
      model: "kimi-k3",
    });
    expect(schemaHasRef(out.find((d) => d.name === "present")!.inputSchema)).toBe(false);
  });

  test("non-kimi providers get identity schemas (recursive present kept)", () => {
    for (const ctx of [
      { providerName: "anthropic", model: "claude-sonnet-4" },
      { providerName: "openai", model: "gpt-4.1" },
      { providerName: "xai/default", model: "grok-4.5" },
      { providerName: "opencode-go", model: "gpt-5.1" },
    ] as const) {
      const out = normalizeToolDefinitionsForProvider(defs, ctx);
      expect(out).toBe(defs);
      const present = out.find((d) => d.name === "present")!;
      expect(schemaHasRef(present.inputSchema)).toBe(true);
      expect(present.inputSchema).toBe(recursivePresent.inputSchema);
    }
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
