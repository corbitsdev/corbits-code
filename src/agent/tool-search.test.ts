import { describe, test, expect } from "bun:test";
import type { ToolDefinition } from "@intx/types/runtime";
import {
  createToolIndex,
  createToolSearchTool,
  createActivatedToolTracker,
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
  {
    name: "read_file",
    description: "read a file",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  // Unadvertised built-in stand-in for ranking tests (web_search is now catalog).
  {
    name: "present",
    description: "search and render layout primitives for pages",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "lsp",
    description: "resolve symbols, find references",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
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
    const results = index.search("present");
    expect(results[0]).toBe("present");
  });

  test("finds an MCP tool by raw substring even when not a whole token", () => {
    expect(index.search("linear")).toContain("mcp__linear__create_issue");
  });

  test("matches by capability words in the description", () => {
    expect(index.search("pages")).toContain("present");
  });

  test("never returns lsp — it is a core tool", () => {
    expect(CORE_TOOL_NAMES).toContain("lsp");
    expect(index.search("find references")).not.toContain("lsp");
  });

  test("never returns a core tool (those are always loaded)", () => {
    expect(CORE_TOOL_NAMES).toContain("read_file");
    expect(index.search("read a file")).not.toContain("read_file");
  });

  test("orchestrator mode advertises task and search_agents", () => {
    expect(advertisedToolNamesForSessionMode("orchestrator", FULL_AVAILABILITY)).toContain("task");
    expect(advertisedToolNamesForSessionMode("orchestrator", FULL_AVAILABILITY)).toContain(
      "search_agents",
    );
  });

  test("search_agents stays a primary CORE advertisement (Skywalker), not a leaf surface", () => {
    // Primary session mode always advertises discovery; leaf/nested directors
    // never receive CORE — their envelopes omit search_agents, and runSubAgent
    // mounts it only for Tier 1 (see tool-sets.test.ts / authority.test.ts).
    expect(CORE_TOOL_NAMES).toContain("search_agents");
    expect(advertisedToolNamesForSessionMode("orchestrator", FULL_AVAILABILITY)).toContain(
      "search_agents",
    );
  });


  test("manage_tasks is advertised regardless of availability", () => {
    expect(coreToolNamesForSessionMode("orchestrator", NO_AVAILABILITY)).toContain("manage_tasks");
  });

  test("present is never in the advertised core set — discovered via tool_search only", () => {
    expect(CORE_TOOL_NAMES).not.toContain("present");
    expect(coreToolNamesForSessionMode("orchestrator", FULL_AVAILABILITY)).not.toContain("present");
  });

  test("primary CORE includes product mutation tools; CATALOG does not duplicate them", () => {
    for (const name of ["write_file", "edit_file", "delete_file"] as const) {
      expect(CORE_TOOL_NAMES).toContain(name);
      expect(CATALOG_TOOL_NAMES).not.toContain(name);
    }
    expect(CORE_TOOL_NAMES).not.toContain("apply_patch");
    expect(CATALOG_TOOL_NAMES).not.toContain("apply_patch");
  });

  test("catalog advertises web_fetch and web_search so URL work needs no tool_search", () => {
    expect(CATALOG_TOOL_NAMES).toContain("web_fetch");
    expect(CATALOG_TOOL_NAMES).toContain("web_search");
    const advertised = advertisedToolNamesForSessionMode("orchestrator", FULL_AVAILABILITY);
    expect(advertised).toContain("web_fetch");
    expect(advertised).toContain("web_search");
  });

  test("lsp is advertised only when a language server was detected at startup", () => {
    expect(
      coreToolNamesForSessionMode("orchestrator", { languageServerAvailable: true }),
    ).toContain("lsp");
    expect(
      coreToolNamesForSessionMode("orchestrator", { languageServerAvailable: false }),
    ).not.toContain("lsp");
  });

  test("ask_operator is advertised regardless of availability", () => {
    expect(coreToolNamesForSessionMode("orchestrator", NO_AVAILABILITY)).toContain("ask_operator");
  });

  test("the advertised set is deterministic — repeat calls with the same inputs are identical", () => {
    const first = coreToolNamesForSessionMode("orchestrator", NO_AVAILABILITY);
    const second = coreToolNamesForSessionMode("orchestrator", NO_AVAILABILITY);
    expect(second).toEqual(first);
  });

  test("returns nothing for an empty query", () => {
    expect(index.search("   ")).toEqual([]);
  });
});

function call(
  tool: ReturnType<typeof createToolSearchTool>,
  args: Record<string, unknown>,
): Promise<string> {
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
    const out = await call(tool, { query: "render layout" });
    expect(promoted).toContain("present");
    expect(out).toContain("present");
    expect(out).toContain("layout");
  });

  test("surfaces a matched tool's input schema so the model can shape arguments", async () => {
    const tool = createToolSearchTool({
      search: (q) => index.search(q),
      lookup: (name) => defs.find((d) => d.name === name),
      promote: () => undefined,
    });
    const out = await call(tool, { query: "issue tracker" });
    expect(out).toContain("mcp__linear__create_issue");
    // Parameter names and the required list must appear — this is the whole
    // point: MCP tools are never in the wire tools array up front, so their
    // schema reaches the model through the tool_search result this same turn,
    // ahead of the promoted definition landing on the next infer call.
    expect(out).toContain("title");
    expect(out).toContain("teamId");
    expect(out).toContain("required");
  });

  test("rejects an empty query", async () => {
    const tool = createToolSearchTool({
      search: () => [],
      lookup: () => undefined,
      promote: () => undefined,
    });
    expect(await call(tool, { query: "  " })).toContain("Error:");
  });

  test("reports when nothing matches", async () => {
    const tool = createToolSearchTool({
      search: () => [],
      lookup: () => undefined,
      promote: () => undefined,
    });
    expect(await call(tool, { query: "nonsense" })).toContain("No tools matched");
  });
});

describe("advertisedTools", () => {
  const registry: ToolDefinition[] = [
    {
      name: "read_file",
      description: "read",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "grep",
      description: "grep",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "write_file",
      description: "write",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "mcp__linear__create_issue",
      description: "create",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
  ];

  test("orchestrator wire prefix names include multi-agent tools", () => {
    const prefix = advertisedToolNamesForSessionMode("orchestrator", FULL_AVAILABILITY);
    expect(prefix).toContain("task");
    expect(prefix).toContain("search_agents");
    // advertisedTools only emits tools present in the registry; multi-agent
    // tools appear on the wire when createAgentToolset registers them.
    const names = advertisedTools(registry, [], prefix).map((d) => d.name);
    expect(names).toContain("read_file");
    expect(names).not.toContain("mcp__linear__create_issue");
  });

  test("with no activation, advertises only the fixed built-in set, never MCP tools", () => {
    const names = advertisedTools(registry).map((d) => d.name);
    expect(names).toContain("read_file");
    expect(names).toContain("grep");
    // write_file is in CORE so the primary can DIY tiny/bounded edits.
    expect(names).toContain("write_file");
    expect(names).not.toContain("mcp__linear__create_issue");
  });

  test("with no activation, the array is byte-identical after an MCP tool is registered (cache prefix survives)", () => {
    const before = JSON.stringify(advertisedTools(registry));
    const grown: ToolDefinition[] = [
      ...registry,
      {
        name: "mcp__acme__do",
        description: "late",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
    ];
    const after = JSON.stringify(advertisedTools(grown));
    expect(after).toBe(before);
  });

  test("the fixed built-in prefix order never changes, activated or not", () => {
    const forward = advertisedTools(registry).map((d) => d.name);
    const reversed = advertisedTools([...registry].reverse()).map((d) => d.name);
    expect(reversed).toEqual(forward);

    const withActivation = advertisedTools(registry, ["mcp__linear__create_issue"]).map(
      (d) => d.name,
    );
    expect(withActivation.slice(0, forward.length)).toEqual(forward);
  });

  test("an activated MCP tool's full definition appears on the wire, appended after the fixed prefix", () => {
    const names = advertisedTools(registry, ["mcp__linear__create_issue"]);
    const linear = names.find((d) => d.name === "mcp__linear__create_issue");
    expect(linear).toBeDefined();
    expect(linear).toEqual(registry[3]);
    // Appended, not interleaved: it lands after every fixed name.
    const idx = names.findIndex((d) => d.name === "mcp__linear__create_issue");
    expect(idx).toBe(names.length - 1);
  });

  test("repeated activation of the same tool does not reorder or duplicate it", () => {
    const once = advertisedTools(registry, ["mcp__linear__create_issue"]).map((d) => d.name);
    const twice = advertisedTools(registry, [
      "mcp__linear__create_issue",
      "mcp__linear__create_issue",
    ]).map((d) => d.name);
    expect(twice).toEqual(once);
    expect(twice.filter((n) => n === "mcp__linear__create_issue")).toHaveLength(1);
  });

  test("multiple activations append in first-activation order regardless of registry order", () => {
    const multi: ToolDefinition[] = [
      ...registry,
      {
        name: "mcp__acme__do",
        description: "late",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
    ];
    const names = advertisedTools(multi, ["mcp__acme__do", "mcp__linear__create_issue"]).map(
      (d) => d.name,
    );
    const tailIdx = names.length - 2;
    expect(names.slice(tailIdx)).toEqual(["mcp__acme__do", "mcp__linear__create_issue"]);
  });

  test("the built-in prefix is byte-identical across repeated turns of the same session", () => {
    // Session-start availability is computed once and must never be
    // re-evaluated per turn — simulate several turns by calling with the same
    // captured prefix and confirm the wire array never drifts.
    const prefix = advertisedToolNamesForSessionMode("orchestrator", {
      languageServerAvailable: true,
    });
    const turn1 = JSON.stringify(advertisedTools(registry, [], prefix));
    const turn2 = JSON.stringify(advertisedTools(registry, [], prefix));
    const turn3 = JSON.stringify(advertisedTools(registry, ["mcp__linear__create_issue"], prefix));
    expect(turn2).toBe(turn1);
    // Growth from a mid-session discovery only appends — the prefix itself
    // (everything before the activated tail) still matches turn 1 exactly.
    expect(turn3.startsWith(turn1.slice(0, -1))).toBe(true);
  });

  test("tool_search never returns an already-advertised built-in", () => {
    for (const name of [...CORE_TOOL_NAMES, ...CATALOG_TOOL_NAMES]) {
      expect(index.search(name)).not.toContain(name);
    }
  });
});

describe("createActivatedToolTracker", () => {
  test("activate adds new names and reports a change", () => {
    const tracker = createActivatedToolTracker();
    expect(tracker.activate(["mcp__linear__create_issue"])).toBe(true);
    expect(tracker.list()).toEqual(["mcp__linear__create_issue"]);
  });

  test("re-activating an already-active name is a no-op — no reorder, no duplicate, no reported change", () => {
    const tracker = createActivatedToolTracker();
    tracker.activate(["mcp__acme__do", "mcp__linear__create_issue"]);
    expect(tracker.activate(["mcp__linear__create_issue"])).toBe(false);
    expect(tracker.list()).toEqual(["mcp__acme__do", "mcp__linear__create_issue"]);
  });

  test("preserves first-activation order across separate calls", () => {
    const tracker = createActivatedToolTracker();
    tracker.activate(["b"]);
    tracker.activate(["a", "b", "c"]);
    expect(tracker.list()).toEqual(["b", "a", "c"]);
  });
});
