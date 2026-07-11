import { describe, test, expect } from "bun:test";
import type { ToolDefinition } from "@intx/types/runtime";
import {
  createToolIndex,
  createToolSearchTool,
  advertisedTools,
  CORE_TOOL_NAMES,
  CATALOG_TOOL_NAMES,
} from "./tool-search.js";

const defs: ToolDefinition[] = [
  { name: "read_file", description: "read a file", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "web_search", description: "search the web for pages", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "lsp", description: "resolve symbols, find references", inputSchema: { type: "object", properties: {}, required: [] } },
  {
    name: "mcp__linear__create_issue",
    description: "Create an issue in the tracker",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Issue title" },
        teamId: { type: "string", description: "Owning team" },
      },
      required: ["title"],
    },
  },
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
  test("lists matches back to the model without mutating any external set", async () => {
    const tool = createToolSearchTool({
      search: (q) => index.search(q),
      lookup: (name) => defs.find((d) => d.name === name),
    });
    const out = await call(tool, { query: "search the web" });
    expect(out).toContain("web_search");
    expect(out).toContain("search the web");
  });

  test("surfaces a matched tool's input schema so the model can shape arguments", async () => {
    const tool = createToolSearchTool({
      search: (q) => index.search(q),
      lookup: (name) => defs.find((d) => d.name === name),
    });
    const out = await call(tool, { query: "issue tracker" });
    expect(out).toContain("mcp__linear__create_issue");
    // Parameter names and the required list must appear — this is the whole
    // point: MCP tools are never in the wire tools array, so their schema only
    // reaches the model through the tool_search result.
    expect(out).toContain("title");
    expect(out).toContain("teamId");
    expect(out).toContain("required");
  });

  test("rejects an empty query", async () => {
    const tool = createToolSearchTool({ search: () => [], lookup: () => undefined });
    expect(await call(tool, { query: "  " })).toContain("Error:");
  });

  test("reports when nothing matches", async () => {
    const tool = createToolSearchTool({ search: () => [], lookup: () => undefined });
    expect(await call(tool, { query: "nonsense" })).toContain("No tools matched");
  });
});

describe("advertisedTools", () => {
  const registry: ToolDefinition[] = [
    { name: "read_file", description: "read", inputSchema: { type: "object", properties: {}, required: [] } },
    { name: "grep", description: "grep", inputSchema: { type: "object", properties: {}, required: [] } },
    { name: "write_file", description: "write", inputSchema: { type: "object", properties: {}, required: [] } },
    { name: "mcp__linear__create_issue", description: "create", inputSchema: { type: "object", properties: {}, required: [] } },
  ];

  test("advertises only the fixed built-in set, never MCP tools", () => {
    const names = advertisedTools(registry).map((d) => d.name);
    expect(names).toContain("read_file");
    expect(names).toContain("grep");
    expect(names).toContain("write_file");
    expect(names).not.toContain("mcp__linear__create_issue");
  });

  test("is byte-identical after an MCP tool is registered (cache prefix survives)", () => {
    const before = JSON.stringify(advertisedTools(registry));
    const grown: ToolDefinition[] = [
      ...registry,
      { name: "mcp__acme__do", description: "late", inputSchema: { type: "object", properties: {}, required: [] } },
    ];
    const after = JSON.stringify(advertisedTools(grown));
    expect(after).toBe(before);
  });

  test("order follows the fixed name list, not the registry order", () => {
    const forward = advertisedTools(registry).map((d) => d.name);
    const reversed = advertisedTools([...registry].reverse()).map((d) => d.name);
    expect(reversed).toEqual(forward);
  });

  test("tool_search never returns an already-advertised built-in", () => {
    for (const name of [...CORE_TOOL_NAMES, ...CATALOG_TOOL_NAMES]) {
      expect(index.search(name)).not.toContain(name);
    }
  });
});
