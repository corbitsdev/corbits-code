import { describe, test, expect, jest } from "bun:test";
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { createAdvertisedToolset } from "../session/assemble-runtime.js";
import { createDynamicToolRunner } from "../tui/dynamic-tool-runner.js";
import {
  createToolIndex,
  createToolSearchTool,
  createActivatedToolTracker,
  advertisedTools,
  advertisedToolNamesForSessionMode,
  coreToolNamesForSessionMode,
  CORE_TOOL_NAMES,
  CATALOG_TOOL_NAMES,
  TOOL_SEARCH_PENDING_WAIT_MS,
  TOOL_SEARCH_RECONNECT_WAIT_MS,
  TOOL_SEARCH_DESC_MAX,
  TOOL_SEARCH_MAX_RESULTS,
  TOOL_SEARCH_LIMIT_MAX,
  toolSearchDefinition,
  type ToolAvailability,
} from "./tool-search.js";

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

  test("skill_search is catalog-advertised at the end, never CORE", () => {
    expect(CORE_TOOL_NAMES).not.toContain("skill_search");
    expect(CATALOG_TOOL_NAMES[CATALOG_TOOL_NAMES.length - 1]).toBe(
      "skill_search",
    );
    const advertised = advertisedToolNamesForSessionMode(
      "orchestrator",
      FULL_AVAILABILITY,
    );
    expect(advertised).toContain("skill_search");
    expect(advertised[advertised.length - 1]).toBe("skill_search");
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
    .map((line) => line.slice(2).split(":")[0]!.trim());
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
    expect(
      advertisedTools(defs).map((d) => d.name),
    ).not.toContain("present");
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
    expect(toolSearchDefinition.inputSchema).toMatchObject({
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

  test("returns name and capped description without a full input schema", async () => {
    const tool = createToolSearchTool({
      search: (q) => linearIndex.search(q),
      lookup: (name) => linearCatalog.find((d) => d.name === name),
    });
    const out = await call(tool, { query: "linear issue" });
    expect(out).toContain("mcp__linear__");
    expect(out).not.toMatch(/input schema/i);
    expect(out).not.toContain("teamId");
    expect(out).not.toContain("end-marker");
    const descLines = out
      .split("\n")
      .filter((line) => line.startsWith("- mcp__"));
    expect(descLines.length).toBeGreaterThan(0);
    for (const line of descLines) {
      expect(line.length).toBeLessThanOrEqual(200);
    }
    expect(out).not.toMatch(/call them now/i);
    expect(out).not.toMatch(/promoted onto/i);
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
    expect(out).toContain("No tools matched");
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
  const stringTool = (name: string, reply: string, description: string): AgentTool => ({
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
      ...wideCatalog.map((d) => stringTool(d.name, `ran:${d.name}`, d.description)),
      stringTool(
        "mcp__never__searched",
        "ran:never",
        "A tool the model never searched for",
      ),
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

  test("a tool_search call does not change the advertised set", async () => {
    const { advertised, promoted, search, runner } = wirePromoteOnExecute();
    const before = advertisedNames(advertised, runner);
    if (search.kind !== "string") throw new Error("expected string tool");
    const out = await search.handler(
      { query: "linear issue", limit: 3 },
      new AbortController().signal,
    );
    expect(listedToolNames(out).length).toBe(3);
    expect(promoted).toEqual([]);
    expect(advertised.activated.list()).toEqual([]);
    expect(advertisedNames(advertised, runner)).toEqual(before);
  });

  test("a subsequent call to a searched name promotes only that name", async () => {
    const { advertised, promoted, search, runner } = wirePromoteOnExecute();
    if (search.kind !== "string") throw new Error("expected string tool");
    const listed = listedToolNames(
      await search.handler(
        { query: "linear issue", limit: 3 },
        new AbortController().signal,
      ),
    );
    expect(listed).toHaveLength(3);
    expect(promoted).toEqual([]);
    const called = listed[0]!;
    const others = listed.slice(1);
    const result = await dispatch(runner, called);
    expect(result.content).toBe(`ran:${called}`);
    expect(result.isError).toBeUndefined();
    expect(promoted).toEqual([called]);
    const names = advertisedNames(advertised, runner);
    expect(names).toContain(called);
    for (const other of others) {
      expect(names).not.toContain(other);
    }
  });

  test("a never-searched undeclared name still promote-on-execute", async () => {
    const { advertised, promoted, runner } = wirePromoteOnExecute();
    const result = await dispatch(runner, "mcp__never__searched");
    expect(result.content).toBe("ran:never");
    expect(result.isError).toBeUndefined();
    expect(promoted).toEqual(["mcp__never__searched"]);
    expect(advertisedNames(advertised, runner)).toContain("mcp__never__searched");
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
    // Session-start availability is computed once and must never be
    // re-evaluated per turn — simulate several turns by calling with the same
    // captured prefix and confirm the wire array never drifts.
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

  test("tool_search does not return skill_search even when it is registered", () => {
    const withSkillSearch: ToolDefinition[] = [
      ...defs,
      {
        name: "skill_search",
        description: "Look up skill details by capability",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
    ];
    const idx = createToolIndex(() => withSkillSearch);
    expect(idx.search("skill")).not.toContain("skill_search");
    expect(idx.search("capability")).not.toContain("skill_search");
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
