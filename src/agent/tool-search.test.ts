import { describe, test, expect } from "bun:test";
import type { ToolDefinition } from "@intx/types/runtime";
import { createToolIndex, createToolSearchTool, CORE_TOOL_NAMES } from "./tool-search.js";

const defs: ToolDefinition[] = [
  { name: "read_file", description: "read a file", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "web_search", description: "search the web for pages", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "lsp", description: "resolve symbols, find references", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "mcp__linear__create_issue", description: "Create an issue in the tracker", inputSchema: { type: "object", properties: {}, required: [] } },
];

const index = createToolIndex(() => defs);

describe("createToolIndex", () => {
  test("ranks a name-token match above a description-only match", () => {
    const results = index.search("search");
    expect(results[0]).toBe("web_search");
  });

  test("finds an MCP tool by raw substring even when not a whole token", () => {
    expect(index.search("linear")).toContain("mcp__linear__create_issue");
  });

  test("matches by capability words in the description", () => {
    expect(index.search("pages")).toContain("web_search");
  });

  test("never returns lsp — it is a core tool", () => {
    expect(CORE_TOOL_NAMES).toContain("lsp");
    expect(index.search("find references")).not.toContain("lsp");
  });

  test("never returns a core tool (those are always loaded)", () => {
    expect(CORE_TOOL_NAMES).toContain("read_file");
    expect(index.search("read a file")).not.toContain("read_file");
  });

  // task is a first-class multi-agent surface: always advertised so the model
  // can dispatch immediately after search_agents without a tool_search hop.
  test("task is a core tool", () => {
    expect(CORE_TOOL_NAMES).toContain("task");
    expect(CORE_TOOL_NAMES).toContain("search_agents");
  });

  test("returns nothing for an empty query", () => {
    expect(index.search("   ")).toEqual([]);
  });
});

function call(tool: ReturnType<typeof createToolSearchTool>, args: Record<string, unknown>): Promise<string> {
  if (tool.kind !== "string") throw new Error("expected string tool");
  return tool.handler(args, new AbortController().signal);
}

describe("createToolSearchTool", () => {
  test("promotes matches and lists them back to the model", async () => {
    const promoted: string[] = [];
    const tool = createToolSearchTool({
      search: (q) => index.search(q),
      lookup: (name) => defs.find((d) => d.name === name),
      promote: (names) => promoted.push(...names),
    });
    const out = await call(tool, { query: "search the web" });
    expect(promoted).toContain("web_search");
    expect(out).toContain("web_search");
    expect(out).toContain("search the web");
  });

  test("rejects an empty query", async () => {
    const tool = createToolSearchTool({ search: () => [], lookup: () => undefined, promote: () => undefined });
    expect(await call(tool, { query: "  " })).toContain("Error:");
  });

  test("reports when nothing matches", async () => {
    const tool = createToolSearchTool({ search: () => [], lookup: () => undefined, promote: () => undefined });
    expect(await call(tool, { query: "nonsense" })).toContain("No tools matched");
  });
});
