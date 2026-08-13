import { describe, test, expect } from "bun:test";
import type { ToolDefinition } from "@intx/types/runtime";
import {
  createToolIndex,
  createToolSearchTool,
  advertisedTools,
  advertisedToolNamesForSessionMode,
  coreToolNamesForSessionMode,
  CORE_TOOL_NAMES,
  CATALOG_TOOL_NAMES,
  type ToolAvailability,
} from "./tool-search.js";

const FULL_AVAILABILITY: ToolAvailability = {
  languageServerAvailable: true,
};
const NO_AVAILABILITY: ToolAvailability = {
  languageServerAvailable: false,
};

const defs: ToolDefinition[] = [
  { name: "read_file", description: "read a file", inputSchema: { type: "object", properties: {}, required: [] } },
  {
    name: "mcp__exa__web_search_exa",
    description: "search the web for any topic and get clean content",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
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
    expect(results[0]).toBe("mcp__exa__web_search_exa");
  });

  test("finds an MCP tool by raw substring even when not a whole token", () => {
    expect(index.search("linear")).toContain("mcp__linear__create_issue");
  });

  test("matches by capability words in the description", () => {
    expect(index.search("topic")).toContain("mcp__exa__web_search_exa");
  });

  test("returns empty for a query that matches nothing", () => {
    expect(index.search("zzzznonexistent")).toEqual([]);
  });

  test("returns empty for a blank query", () => {
    expect(index.search("   ")).toEqual([]);
  });

  test("excludes already-advertised tools from results", () => {
    const withAdvertised = createToolIndex(() => defs, ["mcp__exa__web_search_exa"]);
    expect(withAdvertised.search("search")).not.toContain("mcp__exa__web_search_exa");
  });

  test("prefers Exa over other MCP web tools when both match", () => {
    const withExa: ToolDefinition[] = [
      ...defs,
      {
        name: "mcp__other__web_search",
        description: "search the web for pages",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
    ];
    const ranked = createToolIndex(() => withExa).search("search the web");
    expect(ranked[0]).toBe("mcp__exa__web_search_exa");
    expect(ranked.length).toBeLessThanOrEqual(3);
  });

  test("does not return web_fetch or web_search — they are catalog tools on the wire", () => {
    expect(CATALOG_TOOL_NAMES).toContain("web_fetch");
    expect(CATALOG_TOOL_NAMES).toContain("web_search");
    const withWeb: ToolDefinition[] = [
      ...defs,
      {
        name: "web_fetch",
        description: "fetch a web page over HTTP",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "web_search",
        description: "search the web for pages",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
    ];
    const ranked = createToolIndex(() => withWeb).search("fetch a web page");
    expect(ranked).not.toContain("web_fetch");
    expect(ranked).not.toContain("web_search");
  });
});

describe("coreToolNamesForSessionMode", () => {
  test("omits multi-agent tools in single mode; lsp is not on the fixed wire", () => {
    const single = coreToolNamesForSessionMode("single", FULL_AVAILABILITY);
    expect(single).not.toContain("task");
    expect(single).not.toContain("search_agents");
    expect(single).not.toContain("lsp");
    expect(coreToolNamesForSessionMode("orchestrator", FULL_AVAILABILITY)).toContain("task");
    expect(coreToolNamesForSessionMode("orchestrator", NO_AVAILABILITY)).not.toContain("lsp");
  });
});

function call(tool: ReturnType<typeof createToolSearchTool>, args: Record<string, unknown>): Promise<string> {
  if (tool.kind !== "string") throw new Error("expected string tool");
  return tool.handler(args, new AbortController().signal);
}

describe("createToolSearchTool", () => {
  test("lists matches as free-name dispatch cards (no wire promotion)", async () => {
    const tool = createToolSearchTool({
      search: (q) => index.search(q),
      lookup: (name) => defs.find((d) => d.name === name),
    });
    const out = await call(tool, { query: "search the web" });
    expect(out).toContain("mcp__exa__web_search_exa");
    expect(out).toContain("already dispatchable");
    expect(out).toContain("call by exact name");
  });

  test("surfaces a matched tool's input schema so the model can shape arguments", async () => {
    const tool = createToolSearchTool({
      search: (q) => index.search(q),
      lookup: (name) => defs.find((d) => d.name === name),
    });
    const out = await call(tool, { query: "issue tracker" });
    expect(out).toContain("mcp__linear__create_issue");
    // Parameter names and the required list must appear — MCP tools are never in
    // the wire tools array, so schema reaches the model through this card only.
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
    { name: "write_file", description: "write", inputSchema: { type: "object", properties: {}, required: [] } },
    { name: "grep", description: "grep", inputSchema: { type: "object", properties: {}, required: [] } },
    { name: "list_dir", description: "list", inputSchema: { type: "object", properties: {}, required: [] } },
    { name: "search_files", description: "glob", inputSchema: { type: "object", properties: {}, required: [] } },
    { name: "web_fetch", description: "fetch", inputSchema: { type: "object", properties: {}, required: [] } },
    { name: "mcp__linear__create_issue", description: "create", inputSchema: { type: "object", properties: {}, required: [] } },
  ];

  test("single session mode omits multi-agent tools from the wire prefix", () => {
    const names = advertisedTools(
      registry,
      advertisedToolNamesForSessionMode("single", FULL_AVAILABILITY),
    ).map((d) => d.name);
    expect(names).not.toContain("task");
    expect(names).not.toContain("search_agents");
    expect(names).toContain("read_file");
  });

  test("fixed wire is file/shell loop + blocked-shell substitutes; list_dir/lsp/MCP stay free-name", () => {
    const names = advertisedTools(registry).map((d) => d.name);
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
    expect(names).toContain("grep");
    expect(names).toContain("search_files");
    expect(names).toContain("web_fetch");
    expect(names).not.toContain("list_dir");
    expect(names).not.toContain("mcp__linear__create_issue");
  });

  test("catalog is only search + web (banned shell substitutes)", () => {
    expect([...CATALOG_TOOL_NAMES]).toEqual(["grep", "search_files", "web_fetch", "web_search"]);
  });

  test("wire array is byte-identical after an MCP tool is registered (cache prefix survives)", () => {
    const before = JSON.stringify(advertisedTools(registry));
    const grown: ToolDefinition[] = [
      ...registry,
      { name: "mcp__acme__do", description: "late", inputSchema: { type: "object", properties: {}, required: [] } },
    ];
    const after = JSON.stringify(advertisedTools(grown));
    expect(after).toBe(before);
  });

  test("fixed built-in prefix order never changes with registry order", () => {
    const forward = advertisedTools(registry).map((d) => d.name);
    const reversed = advertisedTools([...registry].reverse()).map((d) => d.name);
    expect(reversed).toEqual(forward);
  });

  test("mid-session discovery never grows the wire — free-name only", () => {
    const prefix = advertisedToolNamesForSessionMode("orchestrator", {
      languageServerAvailable: true,
    });
    const turn1 = JSON.stringify(advertisedTools(registry, prefix));
    const turn2 = JSON.stringify(advertisedTools(registry, prefix));
    const withMcpRegistered: ToolDefinition[] = [
      ...registry,
      { name: "mcp__acme__do", description: "late", inputSchema: { type: "object", properties: {}, required: [] } },
    ];
    const turn3 = JSON.stringify(advertisedTools(withMcpRegistered, prefix));
    expect(turn2).toBe(turn1);
    expect(turn3).toBe(turn1);
  });

  test("tool_search never returns an already-advertised built-in", () => {
    for (const name of [...CORE_TOOL_NAMES, ...CATALOG_TOOL_NAMES]) {
      expect(index.search(name)).not.toContain(name);
    }
  });
});
