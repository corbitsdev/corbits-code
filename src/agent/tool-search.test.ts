import { describe, test, expect, jest } from "bun:test";
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { createAdvertisedToolset } from "../session/assemble-runtime.js";
import { createDynamicToolRunner } from "./dynamic-tool-runner.js";
import {
  createToolIndex,
  createToolSearchTool,
  createActivatedToolTracker,
  advertisedTools,
  advertisedToolNamesForSessionMode,
  advertisedToolNamesForWorker,
  coreToolNamesForSessionMode,
  CORE_TOOL_NAMES,
  CATALOG_TOOL_NAMES,
  TOOL_SEARCH_PENDING_WAIT_MS,
  TOOL_SEARCH_RECONNECT_WAIT_MS,
  TOOL_SEARCH_DESC_MAX,
  TOOL_SEARCH_MAX_RESULTS,
  TOOL_SEARCH_LIMIT_MAX,
  TOOL_SEARCH_SCHEMA_MAX,
  TOOL_SEARCH_SCHEMA_CARDS,
  toolSearchDefinition,
  type ToolAvailability,
} from "./tool-search.js";
import {
  BUILD_TOOLS,
  DOCS_TOOLS,
  ORCHESTRATOR_TOOLS,
  READ_TOOLS,
} from "./directors/tool-sets.js";

const FULL_AVAILABILITY: ToolAvailability = {
  languageServerAvailable: true,
  // Exec-primary mount: wait_agents stays advertised here.
  waitAgentsMounted: true,
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

function mcpDef(
  name: string,
  description: string,
  extraSchema?: Record<string, unknown>,
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: extraSchema ?? {},
      required: [],
    },
  };
}

const linearCatalog: ToolDefinition[] = [
  mcpDef("mcp__linear__list_issues", "List issues in Linear"),
  mcpDef("mcp__linear__get_issue", "Get a Linear issue"),
  mcpDef("mcp__linear__save_issue", "Save a Linear issue"),
  mcpDef("mcp__linear__create_issue", "Create a Linear issue"),
  mcpDef("mcp__linear__delete_issue", "Delete a Linear issue"),
  mcpDef("mcp__linear__update_issue", "Update a Linear issue"),
  mcpDef("mcp__linear__archive_issue", "Archive a Linear issue"),
  mcpDef("mcp__linear__assign_issue", "Assign a Linear issue"),
  mcpDef("mcp__linear__label_issue", "Label a Linear issue"),
  mcpDef("mcp__linear__list_comments", "List comments on a Linear issue"),
  mcpDef("mcp__linear__save_comment", "Save a comment on a Linear issue"),
  mcpDef("mcp__linear__list_projects", "List Linear projects"),
  mcpDef("mcp__github__create_issue", "Create a GitHub issue"),
  mcpDef(
    "mcp__linear__verbose_issue",
    `${"A very long Linear issue description. ".repeat(20)}end-marker`,
    { title: { type: "string" }, teamId: { type: "string" } },
  ),
];

const linearIndex = createToolIndex(() => linearCatalog);

const wideCatalog: ToolDefinition[] = Array.from({ length: 12 }, (_, i) =>
  mcpDef(
    `mcp__linear__op_${String(i).padStart(2, "0")}`,
    "Linear issue operation",
  ),
);
const wideIndex = createToolIndex(() => wideCatalog);

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
    expect(CORE_TOOL_NAMES).toContain("read");
    expect(index.search("read a file")).not.toContain("read_file");
    expect(index.search("read a file")).not.toContain("read");
  });

  test("orchestrator mode advertises the fleet verbs", () => {
    const advertised = advertisedToolNamesForSessionMode(
      "orchestrator",
      FULL_AVAILABILITY,
    );
    for (const name of [
      "spawn_agent",
      "wait_agents",
      "list_agents",
      "close_agent",
      "resume_agent",
      "interrupt_agent",
      "send_input",
    ] as const) {
      expect(CORE_TOOL_NAMES).toContain(name);
      expect(advertised).toContain(name);
    }
  });

  test("wait_agents is advertised only when mounted (exec primary)", () => {
    for (const availability of [
      { languageServerAvailable: true, waitAgentsMounted: false },
      { languageServerAvailable: true },
    ] as const) {
      const advertised = advertisedToolNamesForSessionMode(
        "orchestrator",
        availability,
      );
      expect(advertised).not.toContain("wait_agents");
      // The rest of the fleet surface stays advertised on TUI/nested.
      for (const name of [
        "spawn_agent",
        "list_agents",
        "send_input",
      ] as const) {
        expect(advertised).toContain(name);
      }
    }
    expect(
      advertisedToolNamesForSessionMode("orchestrator", FULL_AVAILABILITY),
    ).toContain("wait_agents");
  });

  test("manage_tasks is advertised regardless of availability", () => {
    expect(
      coreToolNamesForSessionMode("orchestrator", NO_AVAILABILITY),
    ).toContain("manage_tasks");
  });

  test("present is never in the advertised core set — discovered via tool_search only", () => {
    expect(CORE_TOOL_NAMES).not.toContain("present");
    expect(
      coreToolNamesForSessionMode("orchestrator", FULL_AVAILABILITY),
    ).not.toContain("present");
  });

  test("primary CORE includes product mutation tools; CATALOG does not duplicate them", () => {
    for (const name of ["write", "edit", "delete"] as const) {
      expect(CORE_TOOL_NAMES).toContain(name);
      expect(CATALOG_TOOL_NAMES).not.toContain(name);
    }
    expect(CORE_TOOL_NAMES).not.toContain("apply_patch");
    expect(CATALOG_TOOL_NAMES).not.toContain("apply_patch");
  });

  test("catalog advertises web_fetch and web_search so URL work needs no tool_search", () => {
    expect(CATALOG_TOOL_NAMES).toContain("web_fetch");
    expect(CATALOG_TOOL_NAMES).toContain("web_search");
    const advertised = advertisedToolNamesForSessionMode(
      "orchestrator",
      FULL_AVAILABILITY,
    );
    expect(advertised).toContain("web_fetch");
    expect(advertised).toContain("web_search");
  });

  test("skill_search is never advertised; skills are found via tool_search", () => {
    expect(CORE_TOOL_NAMES).not.toContain("skill_search");
    expect(CATALOG_TOOL_NAMES).not.toContain("skill_search");
    expect(
      advertisedToolNamesForSessionMode("orchestrator", FULL_AVAILABILITY),
    ).not.toContain("skill_search");
  });

  test("lsp is advertised only when a language server was detected at startup", () => {
    expect(
      coreToolNamesForSessionMode("orchestrator", {
        languageServerAvailable: true,
      }),
    ).toContain("lsp");
    expect(
      coreToolNamesForSessionMode("orchestrator", {
        languageServerAvailable: false,
      }),
    ).not.toContain("lsp");
  });

  test("ask_operator is advertised when the operator is available", () => {
    expect(
      coreToolNamesForSessionMode("orchestrator", NO_AVAILABILITY),
    ).toContain("ask_operator");
    expect(
      advertisedToolNamesForSessionMode("orchestrator", {
        languageServerAvailable: true,
        operatorAvailable: true,
      }),
    ).toContain("ask_operator");
  });

  test("ask_operator is omitted from the advertised prefix when the operator is unavailable", () => {
    expect(
      coreToolNamesForSessionMode("orchestrator", {
        languageServerAvailable: false,
        operatorAvailable: false,
      }),
    ).not.toContain("ask_operator");
    expect(
      advertisedToolNamesForSessionMode("orchestrator", {
        languageServerAvailable: true,
        operatorAvailable: false,
      }),
    ).not.toContain("ask_operator");
  });

  test("returns nothing for an empty query", () => {
    expect(index.search("   ")).toEqual([]);
  });

  test("with an allow list, never returns tools outside the allow list", () => {
    const allowed = createToolIndex(() => defs, [], ["present"]);
    expect(allowed.search("pages")).toContain("present");
    expect(allowed.search("linear")).not.toContain("mcp__linear__create_issue");
  });

  test("ranks a save-issue query above list-issue tools", () => {
    const ranked = linearIndex.search("linear issue save");
    expect(ranked[0]).toBe("mcp__linear__save_issue");
    const listPos = ranked.indexOf("mcp__linear__list_issues");
    if (listPos !== -1) {
      expect(ranked.indexOf("mcp__linear__save_issue")).toBeLessThan(listPos);
    }
  });

  test("caps a broad linear-issue query to a handful of top matches", () => {
    const ranked = linearIndex.search("linear issue");
    expect(ranked.length).toBeGreaterThan(1);
    expect(ranked.length).toBeLessThanOrEqual(TOOL_SEARCH_MAX_RESULTS);
    expect(ranked.every((name) => name.includes("linear"))).toBe(true);
  });

  test("default search returns at most 5 equally-scoring matches", () => {
    const ranked = wideIndex.search("linear issue");
    expect(ranked).toHaveLength(TOOL_SEARCH_MAX_RESULTS);
  });

  test("an explicit limit overrides the default cap", () => {
    expect(wideIndex.search("linear issue", 3)).toHaveLength(3);
    expect(wideIndex.search("linear issue", 8)).toHaveLength(8);
  });

  test("a specific save query returns one or two tools, not the whole family", () => {
    const ranked = linearIndex.search("linear issue save");
    expect(ranked).toContain("mcp__linear__save_issue");
    expect(ranked.length).toBeGreaterThanOrEqual(1);
    expect(ranked.length).toBeLessThanOrEqual(2);
  });
});

describe("createToolSearchTool skills", () => {
  test("skill matches render as a use_skill block", async () => {
    const tool = createToolSearchTool({
      search: () => [],
      searchSkills: () => ["- scribe: write docs"],
      lookup: () => undefined,
    });
    const out = await call(tool, { query: "docs" });
    expect(out).toContain("use_skill");
    expect(out).toContain("- scribe: write docs");
  });

  test("a skill hit still waits for a connecting server so its tools mount", async () => {
    const live: ToolDefinition[] = [];
    const tool = createToolSearchTool({
      search: (query) => createToolIndex(() => live).search(query),
      searchSkills: () => ["- linear-triage: triage issues"],
      lookup: (name) => live.find((def) => def.name === name),
      awaitPendingConnections: async () => {
        live.push({
          name: "mcp__linear__create_issue",
          description: "Create an issue in the tracker",
          inputSchema: { type: "object", properties: {}, required: [] },
        });
        return 0;
      },
    });
    const out = await call(tool, { query: "linear tracker" });
    expect(out).toContain("mcp__linear__create_issue");
    expect(out).toContain("- linear-triage: triage issues");
  });
});

function call(
  tool: ReturnType<typeof createToolSearchTool>,
  args: Record<string, unknown>,
): Promise<string> {
  if (tool.kind !== "string") throw new Error("expected string tool");
  return tool.handler(args, new AbortController().signal);
}

function listedToolNames(out: string): string[] {
  return out
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .flatMap((line) => {
      const name = line.slice(2).split(":")[0];
      return name === undefined ? [] : [name.trim()];
    });
}

async function flushMicrotasks(rounds = 100): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

async function advanceAndFlush(ms: number): Promise<void> {
  jest.advanceTimersByTime(ms);
  await flushMicrotasks();
}

describe("createToolSearchTool", () => {
  test("lists matching cards and does not promote", async () => {
    const tool = createToolSearchTool({
      search: (q) => index.search(q),
      lookup: (name) => defs.find((d) => d.name === name),
    });
    const out = await call(tool, { query: "render layout" });
    expect(out).toContain("present");
    expect(out).toContain("layout");
    expect(out).not.toMatch(/promoted/i);
    expect(advertisedTools(defs).map((d) => d.name)).not.toContain("present");
  });

  test("default tool_search returns at most 5 matches and does not promote them", async () => {
    const tool = createToolSearchTool({
      search: (q, limit) => wideIndex.search(q, limit),
      lookup: (name) => wideCatalog.find((d) => d.name === name),
    });
    const before = advertisedTools(wideCatalog).map((d) => d.name);
    const out = await call(tool, { query: "linear issue" });
    const listed = listedToolNames(out);
    expect(listed).toHaveLength(TOOL_SEARCH_MAX_RESULTS);
    expect(listed.length).toBeLessThan(wideCatalog.length);
    expect(advertisedTools(wideCatalog).map((d) => d.name)).toEqual(before);
    expect(listed.every((name) => !before.includes(name))).toBe(true);
  });

  test("limit 3 overrides the default cap", async () => {
    const tool = createToolSearchTool({
      search: (q, limit) => wideIndex.search(q, limit),
      lookup: (name) => wideCatalog.find((d) => d.name === name),
    });
    const listed = listedToolNames(
      await call(tool, { query: "linear issue", limit: 3 }),
    );
    expect(listed).toHaveLength(3);
  });

  test("limit above the default returns the wider set", async () => {
    const tool = createToolSearchTool({
      search: (q, limit) => wideIndex.search(q, limit),
      lookup: (name) => wideCatalog.find((d) => d.name === name),
    });
    const listed = listedToolNames(
      await call(tool, { query: "linear issue", limit: 8 }),
    );
    expect(listed).toHaveLength(8);
  });

  test("limit above the hard cap clamps to 20", async () => {
    const hugeCatalog: ToolDefinition[] = Array.from({ length: 25 }, (_, i) =>
      mcpDef(
        `mcp__linear__huge_${String(i).padStart(2, "0")}`,
        "Linear issue operation",
      ),
    );
    const hugeIndex = createToolIndex(() => hugeCatalog);
    const tool = createToolSearchTool({
      search: (q, limit) => hugeIndex.search(q, limit),
      lookup: (name) => hugeCatalog.find((d) => d.name === name),
    });
    const listed = listedToolNames(
      await call(tool, { query: "linear issue", limit: 100 }),
    );
    expect(listed).toHaveLength(TOOL_SEARCH_LIMIT_MAX);
    // Bun's nested asymmetric matcher mutates its received object; keep the
    // canonical definition JSON-serializable for later worker tests.
    expect(structuredClone(toolSearchDefinition.inputSchema)).toMatchObject({
      properties: {
        limit: {
          description: expect.stringContaining("hard cap 20"),
        },
      },
    });
  });

  test("missing or invalid limit falls back to 5", async () => {
    const makeTool = () =>
      createToolSearchTool({
        search: (q, limit) => wideIndex.search(q, limit),
        lookup: (name) => wideCatalog.find((d) => d.name === name),
      });
    for (const args of [
      { query: "linear issue" },
      { query: "linear issue", limit: "nope" },
      { query: "linear issue", limit: 0 },
      { query: "linear issue", limit: -3 },
      { query: "linear issue", limit: Number.NaN },
    ] as Record<string, unknown>[]) {
      const listed = listedToolNames(await call(makeTool(), args));
      expect(listed).toHaveLength(TOOL_SEARCH_MAX_RESULTS);
    }
  });

  test("returned names are a handful, not the whole catalog", async () => {
    const tool = createToolSearchTool({
      search: (q, limit) => wideIndex.search(q, limit),
      lookup: (name) => wideCatalog.find((d) => d.name === name),
    });
    const listed = listedToolNames(
      await call(tool, { query: "linear issue", limit: 3 }),
    );
    const catalogNames = wideCatalog.map((d) => d.name);
    expect(listed).toHaveLength(3);
    expect(catalogNames.every((name) => listed.includes(name))).toBe(false);
    expect(listed.every((name) => catalogNames.includes(name))).toBe(true);
  });

  test("search loads the top ranked names when a promoter is wired", async () => {
    const catalog: ToolDefinition[] = Array.from({ length: 8 }, (_, i) => ({
      name: `mcp__linear__op_${i}`,
      description: "Linear issue operation",
      inputSchema: {
        type: "object",
        properties: { [`field_${i}`]: { type: "string" } },
        required: [`field_${i}`],
      },
    }));
    const loaded: string[] = [];
    const tool = createToolSearchTool({
      search: () => catalog.map((d) => d.name),
      lookup: (name) => catalog.find((d) => d.name === name),
      promote: (names) => {
        loaded.push(...names);
      },
    });
    const out = await call(tool, { query: "linear" });
    expect(loaded).toEqual(
      catalog.slice(0, TOOL_SEARCH_SCHEMA_CARDS).map((d) => d.name),
    );
    expect(out).toContain("mcp__linear__op_7");
    expect(out).not.toContain("field_7");
  });

  test("search cards include the input schema so a first call is formable", async () => {
    const tool = createToolSearchTool({
      search: (q) => index.search(q),
      lookup: (name) => defs.find((d) => d.name === name),
    });
    const out = await call(tool, { query: "linear issue create" });
    expect(out).toContain("mcp__linear__create_issue");
    expect(out).toContain("title");
    expect(out).toContain("teamId");
    expect(advertisedTools(defs).map((d) => d.name)).not.toContain(
      "mcp__linear__create_issue",
    );
  });

  test("only the top ranked cards include input schema", async () => {
    const catalog: ToolDefinition[] = Array.from({ length: 8 }, (_, i) => ({
      name: `mcp__linear__op_${i}`,
      description: "Linear issue operation",
      inputSchema: {
        type: "object",
        properties: { [`field_${i}`]: { type: "string" } },
        required: [`field_${i}`],
      },
    }));
    const tool = createToolSearchTool({
      search: () => catalog.map((d) => d.name),
      lookup: (name) => catalog.find((d) => d.name === name),
    });
    const out = await call(tool, { query: "linear" });
    expect(listedToolNames(out)).toEqual(catalog.map((d) => d.name));
    expect(out).toContain("field_0");
    expect(out).toContain("field_4");
    expect(out).not.toContain("field_5");
    expect(out).not.toContain("field_7");
    expect(out).toContain("mcp__linear__op_7");
  });

  test("tool_search description says top matches join the list next turn", () => {
    expect(toolSearchDefinition.description).toMatch(/next turn/i);
    expect(toolSearchDefinition.description).toMatch(/schema/i);
  });

  test("an oversized input schema is capped on the card", async () => {
    const hugeProps = Object.fromEntries(
      Array.from({ length: 80 }, (_, i) => [
        `field_${String(i).padStart(2, "0")}`,
        { type: "string", description: "x".repeat(40) },
      ]),
    );
    const huge: ToolDefinition = {
      name: "mcp__linear__huge_schema",
      description: "Linear issue with a large schema",
      inputSchema: {
        type: "object",
        properties: hugeProps,
        required: ["field_00"],
      },
    };
    const tool = createToolSearchTool({
      search: () => [huge.name],
      lookup: () => huge,
    });
    const out = await call(tool, { query: "linear huge" });
    expect(out).toContain("mcp__linear__huge_schema");
    expect(out).toContain("field_00");
    const schemaLine = out.split("\n").find((line) => line.startsWith("  {"));
    expect(schemaLine).toBeDefined();
    expect(schemaLine?.length ?? 0).toBeLessThanOrEqual(
      TOOL_SEARCH_SCHEMA_MAX + 2,
    );
  });

  test("search does not promote matches and keeps description lines short", async () => {
    const tool = createToolSearchTool({
      search: (q) => linearIndex.search(q),
      lookup: (name) => linearCatalog.find((d) => d.name === name),
    });
    const before = advertisedTools(linearCatalog).map((d) => d.name);
    const out = await call(tool, { query: "linear issue" });
    expect(out).toContain("mcp__linear__");
    expect(out).not.toContain("end-marker");
    expect(advertisedTools(linearCatalog).map((d) => d.name)).toEqual(before);
    const descLines = out
      .split("\n")
      .filter((line) => line.startsWith("- mcp__"));
    expect(descLines.length).toBeGreaterThan(0);
    for (const line of descLines) {
      expect(line.length).toBeLessThanOrEqual(200);
    }
    expect(out).not.toMatch(/call them now/i);
    expect(out).not.toMatch(/promoted onto/i);
    expect(out).not.toMatch(/load on the next turn/i);
    expect(out).toMatch(/call a listed name/i);
  });

  test("a unique description query hits the long card so the cap is exercised", async () => {
    const tool = createToolSearchTool({
      search: (q) => linearIndex.search(q),
      lookup: (name) => linearCatalog.find((d) => d.name === name),
    });
    const ranked = linearIndex.search("end-marker");
    expect(ranked).toContain("mcp__linear__verbose_issue");
    const out = await call(tool, { query: "end-marker" });
    expect(out).toContain("mcp__linear__verbose_issue");
    expect(out).not.toContain("end-marker");
    const card = out
      .split("\n")
      .find((line) => line.startsWith("- mcp__linear__verbose_issue:"));
    expect(card).toBeDefined();
    if (card === undefined) return;
    const desc = card.slice("- mcp__linear__verbose_issue: ".length);
    expect(desc.length).toBe(TOOL_SEARCH_DESC_MAX);
    expect(desc.endsWith("…")).toBe(true);
  });

  test("rejects an empty query", async () => {
    const tool = createToolSearchTool({
      search: () => [],
      lookup: () => undefined,
    });
    expect(await call(tool, { query: "  " })).toContain("Error:");
  });

  test("mid-handshake search waits for a connecting server instead of reporting no match", async () => {
    const live: ToolDefinition[] = [];
    let resolveConnect!: () => void;
    const connected = new Promise<void>((resolve) => {
      resolveConnect = resolve;
    });
    const tool = createToolSearchTool({
      search: (query) => createToolIndex(() => live).search(query),
      lookup: (name) => live.find((def) => def.name === name),
      awaitPendingConnections: async (timeoutMs?: number) => {
        await Promise.race([
          connected,
          new Promise((resolve) => setTimeout(resolve, timeoutMs ?? 50)),
        ]);
        return live.length === 0 ? 1 : 0;
      },
    });
    const pending = call(tool, { query: "linear tracker" });
    live.push({
      name: "mcp__linear__create_issue",
      description: "Create an issue in the tracker",
      inputSchema: { type: "object", properties: {}, required: [] },
    });
    resolveConnect();
    const out = await pending;
    expect(out).toContain("mcp__linear__create_issue");
    expect(out).not.toContain("No tools matched");
  });

  test("a hung connection never hangs the search — bounded wait, then a retry signal", async () => {
    const tool = createToolSearchTool({
      search: () => [],
      lookup: () => undefined,
      awaitPendingConnections: () =>
        new Promise<number>(() => {
          // Never settles: simulates a hung authorization handshake.
        }),
      // The production bound is 1s; a short override exercises the same
      // bounded-wait contract without paying that in wall clock.
      pendingWaitMs: 50,
    });
    const out = await call(tool, { query: "linear" });
    expect(out).toContain("No tools matched");
    expect(out).toMatch(/starting up|still connecting/);
    expect(out).toMatch(/retry.*shortly/i);
    expect(out).not.toContain("different keywords");
  });

  test("two pending connectors report the plural connecting copy", async () => {
    const tool = createToolSearchTool({
      search: () => [],
      lookup: () => undefined,
      awaitPendingConnections: async () => 2,
    });
    const out = await call(tool, { query: "linear" });
    expect(out).toContain("2 connectors are still connecting");
    expect(out).toMatch(/retry.*shortly/i);
    expect(out).not.toContain("different keywords");
  });

  test("a genuine miss keeps the keyword advice and omits the retry caveat", async () => {
    const tool = createToolSearchTool({
      search: () => [],
      lookup: () => undefined,
      awaitPendingConnections: async () => 0,
    });
    const out = await call(tool, { query: "nonsense" });
    expect(out).toContain("matched");
    expect(out).toContain("different keywords");
    expect(out).not.toMatch(
      /still connecting|still starting up|retry shortly/i,
    );
  });

  test("a genuine miss with nothing pending never consults the reconnect predicate", async () => {
    let matchChecks = 0;
    const tool = createToolSearchTool({
      search: () => [],
      lookup: () => undefined,
      awaitPendingConnections: async () => 0,
      hasReconnectingMatch: () => {
        matchChecks += 1;
        return true;
      },
    });
    const out = await call(tool, { query: "nonsense" });
    expect(out).toContain("different keywords");
    expect(matchChecks).toBe(0);
  });

  test("a reconnecting match earns one short extension and finds the remounted tool", async () => {
    jest.useFakeTimers();
    try {
      const live: ToolDefinition[] = [];
      const timeouts: (number | undefined)[] = [];
      const matchQueries: string[] = [];
      let searches = 0;
      const tool = createToolSearchTool({
        search: (query) => {
          searches += 1;
          return createToolIndex(() => live).search(query);
        },
        lookup: (name) => live.find((def) => def.name === name),
        awaitPendingConnections: async (timeoutMs?: number) => {
          timeouts.push(timeoutMs);
          await new Promise((resolve) => setTimeout(resolve, timeoutMs ?? 0));
          return live.length === 0 ? 1 : 0;
        },
        hasReconnectingMatch: (query) => {
          matchQueries.push(query);
          return true;
        },
      });
      const pending = call(tool, { query: "linear tracker" });
      await advanceAndFlush(TOOL_SEARCH_PENDING_WAIT_MS);
      // The redial remounts mid-extension: dropped stubs at tier 1, live set
      // back before the extension elapses.
      live.push({
        name: "mcp__linear__create_issue",
        description: "Create an issue in the tracker",
        inputSchema: { type: "object", properties: {}, required: [] },
      });
      await advanceAndFlush(TOOL_SEARCH_RECONNECT_WAIT_MS);
      const out = await pending;
      expect(out).toContain("mcp__linear__create_issue");
      expect(timeouts).toEqual([
        TOOL_SEARCH_PENDING_WAIT_MS,
        TOOL_SEARCH_RECONNECT_WAIT_MS,
      ]);
      expect(searches).toBe(3);
      expect(matchQueries).toEqual(["linear tracker"]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a needs-auth miss never earns the extension and stays within the tier-1 bound", async () => {
    jest.useFakeTimers();
    try {
      const timeouts: (number | undefined)[] = [];
      let searches = 0;
      let matchChecks = 0;
      const tool = createToolSearchTool({
        search: () => {
          searches += 1;
          return [];
        },
        lookup: () => undefined,
        awaitPendingConnections: async (timeoutMs?: number) => {
          timeouts.push(timeoutMs);
          await new Promise((resolve) => setTimeout(resolve, timeoutMs ?? 0));
          return 1;
        },
        // A needs-auth server never populates the reconnect map, so the
        // toolset predicate stays false for it.
        hasReconnectingMatch: () => {
          matchChecks += 1;
          return false;
        },
      });
      const pending = call(tool, { query: "notion" });
      await advanceAndFlush(TOOL_SEARCH_PENDING_WAIT_MS);
      // Far past any extension: no second wait may be outstanding.
      await advanceAndFlush(10_000);
      const out = await pending;
      expect(out).toMatch(/retry.*shortly/i);
      expect(timeouts).toEqual([TOOL_SEARCH_PENDING_WAIT_MS]);
      expect(searches).toBe(2);
      expect(matchChecks).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("promote-on-execute", () => {
  const stringTool = (
    name: string,
    reply: string,
    description: string,
  ): AgentTool => ({
    kind: "string",
    definition: {
      name,
      description,
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    handler: async () => reply,
  });

  function wirePromoteOnExecute() {
    const tools = [
      ...wideCatalog.map((d) =>
        stringTool(d.name, `ran:${d.name}`, d.description),
      ),
      stringTool(
        "mcp__never__searched",
        "ran:never",
        "A tool the model never searched for",
      ),
      stringTool("list_dir", "listed", "list a directory's entries"),
    ];
    const runner = createDynamicToolRunner(tools);
    const advertised = createAdvertisedToolset({
      sessionMode: "orchestrator",
      toolAvailability: { languageServerAvailable: false },
      getProvider: () => ({ providerName: "test", model: "test" }),
    });
    const promoted: string[] = [];
    runner.setCallGate((name) => advertised.isAdvertised(name), {
      isActivated: (name) => advertised.activated.has(name),
    });
    runner.setOnUndeclaredCall((name) => {
      promoted.push(name);
      advertised.activated.activate([name]);
      advertised.flushPromotions();
    });
    const search = createToolSearchTool({
      search: (q, limit) => wideIndex.search(q, limit),
      lookup: (name) =>
        runner.currentDefinitions().find((d) => d.name === name),
      promote: (names) => {
        advertised.activated.activate(names);
        advertised.flushPromotions();
      },
    });
    return { runner, advertised, promoted, search };
  }

  async function dispatch(
    runner: ReturnType<typeof createDynamicToolRunner>,
    name: string,
  ) {
    return runner.run(
      { id: name, name, arguments: {} },
      new AbortController().signal,
    );
  }

  function advertisedNames(
    advertised: ReturnType<typeof createAdvertisedToolset>,
    runner: ReturnType<typeof createDynamicToolRunner>,
  ): string[] {
    return advertised
      .computeAdvertised(runner.currentDefinitions())
      .map((d) => d.name);
  }

  test("a tool_search call loads ranked hits onto the advertised tail", async () => {
    const { advertised, promoted, search, runner } = wirePromoteOnExecute();
    const before = advertisedNames(advertised, runner);
    if (search.kind !== "string") throw new Error("expected string tool");
    const out = await search.handler(
      { query: "linear issue", limit: 3 },
      new AbortController().signal,
    );
    const listed = listedToolNames(out);
    expect(listed.length).toBe(3);
    expect(promoted).toEqual([]);
    const loaded = listed.slice(0, TOOL_SEARCH_SCHEMA_CARDS);
    const rest = listed.slice(TOOL_SEARCH_SCHEMA_CARDS);
    expect(advertised.activated.list()).toEqual(loaded);
    const after = advertisedNames(advertised, runner);
    for (const name of loaded) expect(after).toContain(name);
    for (const name of rest) expect(after).not.toContain(name);
    expect(before.every((name) => after.includes(name))).toBe(true);
  });

  test("a call to an already-loaded search hit does not re-promote", async () => {
    const { advertised, promoted, search, runner } = wirePromoteOnExecute();
    if (search.kind !== "string") throw new Error("expected string tool");
    const listed = listedToolNames(
      await search.handler(
        { query: "linear issue", limit: 3 },
        new AbortController().signal,
      ),
    );
    expect(listed).toHaveLength(3);
    const called = listed[0];
    if (called === undefined) throw new Error("expected a listed tool");
    const result = await dispatch(runner, called);
    expect(result.content).toBe(`ran:${called}`);
    expect(result.isError).toBeUndefined();
    expect(promoted).toEqual([]);
    expect(advertisedNames(advertised, runner)).toContain(called);
  });

  test("a call to a search hit past the loaded set still promote-on-execute", async () => {
    const { advertised, promoted, search, runner } = wirePromoteOnExecute();
    if (search.kind !== "string") throw new Error("expected string tool");
    const listed = listedToolNames(
      await search.handler(
        { query: "linear issue", limit: 8 },
        new AbortController().signal,
      ),
    );
    const called = listed[TOOL_SEARCH_SCHEMA_CARDS];
    if (called === undefined)
      throw new Error("expected a hit past the load cap");
    const loaded = listed.slice(0, TOOL_SEARCH_SCHEMA_CARDS);
    const result = await dispatch(runner, called);
    expect(result.content).toBe(`ran:${called}`);
    expect(result.isError).toBeUndefined();
    expect(promoted).toEqual([called]);
    const names = advertisedNames(advertised, runner);
    expect(names).toContain(called);
    for (const name of loaded) expect(names).toContain(name);
  });

  test("a never-searched undeclared name still promote-on-execute", async () => {
    const { advertised, promoted, runner } = wirePromoteOnExecute();
    const result = await dispatch(runner, "mcp__never__searched");
    expect(result.content).toBe("ran:never");
    expect(result.isError).toBeUndefined();
    expect(promoted).toEqual(["mcp__never__searched"]);
    expect(advertisedNames(advertised, runner)).toContain(
      "mcp__never__searched",
    );
  });

  test("executing list_dir does not join the advertised tail", async () => {
    const { advertised, promoted, runner } = wirePromoteOnExecute();
    const before = advertisedNames(advertised, runner);
    expect(before).not.toContain("list_dir");
    const result = await dispatch(runner, "list_dir");
    expect(result.content).toBe("listed");
    expect(result.isError).toBeUndefined();
    expect(promoted).toEqual([]);
    expect(advertisedNames(advertised, runner)).toEqual(before);
    expect(advertisedNames(advertised, runner)).not.toContain("list_dir");
  });
});

describe("advertisedToolNamesForWorker", () => {
  test("a custom nested orchestrator without an allowlist advertises its mounted fleet verbs", () => {
    const nested = advertisedToolNamesForWorker({ orchestrator: true });
    expect(nested).toContain("spawn_agent");
    expect(nested).toContain("send_input");
    expect(nested).not.toContain("search_agents");
    expect(nested).not.toContain("ask_operator");
    const restricted = advertisedToolNamesForWorker({
      orchestrator: true,
      allow: READ_TOOLS,
    });
    expect(restricted).not.toContain("spawn_agent");
  });

  test("explorer/read allowlist has no writes and includes tool_search", () => {
    const leaf = advertisedToolNamesForWorker({ allow: READ_TOOLS });
    const dispatch = advertisedToolNamesForSessionMode(
      "orchestrator",
      FULL_AVAILABILITY,
    );
    expect(leaf).toContain("tool_search");
    expect(leaf).toContain("ask_director");
    expect(leaf).toContain("submit_result");
    expect(leaf).toContain("read_file");
    expect(leaf).toContain("run_shell");
    expect(leaf).not.toContain("write_file");
    expect(leaf).not.toContain("spawn_agent");
    expect(leaf).not.toContain("search_agents");
    expect(leaf).not.toContain("ask_operator");
    expect(leaf.every((name) => !name.startsWith("mcp__"))).toBe(true);
    expect(leaf.length).toBeLessThan(dispatch.length);
  });

  test("coder/build allowlist includes path writes, not fleet verbs", () => {
    const coder = advertisedToolNamesForWorker({ allow: BUILD_TOOLS });
    expect(coder).toContain("write_file");
    expect(coder).toContain("edit_file");
    expect(coder).toContain("tool_search");
    expect(coder).not.toContain("spawn_agent");
  });

  test("docs allowlist omits run_shell", () => {
    const docs = advertisedToolNamesForWorker({ allow: DOCS_TOOLS });
    expect(docs).toContain("write_file");
    expect(docs).not.toContain("run_shell");
    expect(docs).toContain("tool_search");
  });

  test("nested orchestrator allowlist adds fleet verbs but not search_agents", () => {
    const orch = advertisedToolNamesForWorker({ allow: ORCHESTRATOR_TOOLS });
    expect(orch).toContain("spawn_agent");
    expect(orch).toContain("send_input");
    expect(orch).toContain("tool_search");
    expect(orch).not.toContain("search_agents");
    expect(orch).not.toContain("ask_operator");
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
    const prefix = advertisedToolNamesForSessionMode(
      "orchestrator",
      FULL_AVAILABILITY,
    );
    expect(prefix).not.toContain("task");
    expect(prefix).toContain("search_agents");
    for (const name of [
      "spawn_agent",
      "wait_agents",
      "list_agents",
      "close_agent",
      "resume_agent",
      "interrupt_agent",
      "send_input",
    ] as const) {
      expect(prefix).toContain(name);
    }
    // advertisedTools only emits tools present in the registry; multi-agent
    // tools appear on the wire when createAgentToolset registers them.
    const names = advertisedTools(registry, [], prefix).map((d) => d.name);
    expect(names).toContain("read");
    expect(names).not.toContain("mcp__linear__create_issue");
  });

  test("with no activation, advertises only the fixed built-in set, never MCP tools", () => {
    const names = advertisedTools(registry).map((d) => d.name);
    expect(names).toContain("read");
    expect(names).toContain("grep");
    // write is in CORE so the primary can DIY tiny/bounded edits.
    expect(names).toContain("write");
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
    const reversed = advertisedTools([...registry].reverse()).map(
      (d) => d.name,
    );
    expect(reversed).toEqual(forward);

    const withActivation = advertisedTools(registry, [
      "mcp__linear__create_issue",
    ]).map((d) => d.name);
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
    const once = advertisedTools(registry, ["mcp__linear__create_issue"]).map(
      (d) => d.name,
    );
    const twice = advertisedTools(registry, [
      "mcp__linear__create_issue",
      "mcp__linear__create_issue",
    ]).map((d) => d.name);
    expect(twice).toEqual(once);
    expect(twice.filter((n) => n === "mcp__linear__create_issue")).toHaveLength(
      1,
    );
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
    const names = advertisedTools(multi, [
      "mcp__acme__do",
      "mcp__linear__create_issue",
    ]).map((d) => d.name);
    const tailIdx = names.length - 2;
    expect(names.slice(tailIdx)).toEqual([
      "mcp__acme__do",
      "mcp__linear__create_issue",
    ]);
  });

  test("the built-in prefix is byte-identical across repeated turns of the same session", () => {
    // Session-start availability is computed once, never per turn — call with
    // the same captured prefix and confirm the wire array never drifts.
    const prefix = advertisedToolNamesForSessionMode("orchestrator", {
      languageServerAvailable: true,
    });
    const turn1 = JSON.stringify(advertisedTools(registry, [], prefix));
    const turn2 = JSON.stringify(advertisedTools(registry, [], prefix));
    const turn3 = JSON.stringify(
      advertisedTools(registry, ["mcp__linear__create_issue"], prefix),
    );
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
    expect(tracker.list()).toEqual([
      "mcp__acme__do",
      "mcp__linear__create_issue",
    ]);
  });

  test("preserves first-activation order across separate calls", () => {
    const tracker = createActivatedToolTracker();
    tracker.activate(["b"]);
    tracker.activate(["a", "b", "c"]);
    expect(tracker.list()).toEqual(["b", "a", "c"]);
  });
});
