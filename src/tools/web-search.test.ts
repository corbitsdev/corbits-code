import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { withMockedModule } from "../../tests/helpers/mock-module.js";
import type { ResolvedMCPServerConfig } from "../mcp/exa.js";

const calls: { toolName: string; args: Record<string, unknown> }[] = [];
let connectConfigs: ResolvedMCPServerConfig[] = [];

// The mock needs to spread the real module rather than replace it outright,
// or any other export (unwrapToolContent, connectMCPServers) disappears for
// the rest of the process for every file that runs after this one.
await withMockedModule(
  import.meta.resolve("../mcp/client.js"),
  (real: typeof import("../mcp/client.js")) => ({
    ...real,
    connectMCPServer: async (config: ResolvedMCPServerConfig) => {
      connectConfigs.push(config);
      return {
        ok: true,
        client: {
          serverName: config.name,
          tools: [],
          call: async (toolName: string, args: Record<string, unknown>) => {
            calls.push({ toolName, args });
            return "mock result";
          },
          close: async () => undefined,
        },
      };
    },
  }),
);

const {
  createWebSearchTool,
  disposeWebSearchClients,
  resolveWebSearchProvider,
  EXA_MCP_URL,
  PARALLEL_MCP_URL,
} = await import("./web-search.js");
const { createAgentToolset } = await import("../agent/tools.js");
const { resolveMcpServers } = await import("../config/index.js");
const { createExaMCPServerConfig } = await import("../mcp/exa.js");
const { createPermissionGate } = await import("../permission/gate.js");

const BUILTIN_EXA_MCP = createExaMCPServerConfig();

async function connectConfiguredMCP(mcpServers?: ResolvedMCPServerConfig[]): Promise<void> {
  const toolset = await createAgentToolset({
    cwd: process.cwd(),
    permissionGate: createPermissionGate({
      approvals: [],
      interactive: false,
      skipPermissions: true,
    }),
    onOperatorGate: async () => ({ kind: "cancel" }),
    ...(mcpServers !== undefined ? { mcpServers } : {}),
  });
  try {
    await toolset.connectMCP({
      interactiveAuth: false,
      onStatus: () => undefined,
      onToolsChanged: () => undefined,
    });
  } finally {
    await toolset.dispose();
  }
}

beforeEach(() => {
  calls.length = 0;
  connectConfigs = [];
  delete process.env.CORBITS_WEB_SEARCH_PROVIDER;
  delete process.env.CORBITS_WEB_SEARCH_API_KEY;
});

afterEach(async () => {
  await disposeWebSearchClients();
  // Leave no provider selection behind for whatever file runs next.
  delete process.env.CORBITS_WEB_SEARCH_PROVIDER;
  delete process.env.CORBITS_WEB_SEARCH_API_KEY;
});

describe("Exa MCP preset connection boundary", () => {
  test("connects the default Exa preset unless it is explicitly disabled", async () => {
    await connectConfiguredMCP();
    expect(connectConfigs).toEqual([BUILTIN_EXA_MCP]);

    connectConfigs = [];
    await connectConfiguredMCP(resolveMcpServers([{ name: "exa", enabled: false }], undefined));
    expect(connectConfigs).toHaveLength(0);

    await connectConfiguredMCP(resolveMcpServers([{ name: "exa", enabled: true }], undefined));
    expect(connectConfigs).toEqual([BUILTIN_EXA_MCP]);
  });
});

describe("resolveWebSearchProvider", () => {
  test("defaults to exa", () => {
    expect(resolveWebSearchProvider({})).toBe("exa");
  });
  test("selects parallel via env override", () => {
    expect(resolveWebSearchProvider({ CORBITS_WEB_SEARCH_PROVIDER: "parallel" })).toBe("parallel");
  });
  test("falls back to exa on an unrecognized value", () => {
    expect(resolveWebSearchProvider({ CORBITS_WEB_SEARCH_PROVIDER: "bing" })).toBe("exa");
  });
});

describe("createWebSearchTool", () => {
  test("calls web_search_exa on the Exa endpoint by default with request defaults", async () => {
    const tool = createWebSearchTool();
    if (tool.kind !== "string") throw new Error("expected a string tool");
    const result = await tool.handler({ query: "corbits code" }, new AbortController().signal);
    expect(result).toBe("mock result");
    expect(connectConfigs[0]?.url).toBe(EXA_MCP_URL);
    expect(calls[0]?.toolName).toBe("web_search_exa");
    expect(calls[0]?.args).toEqual({
      query: "corbits code",
      numResults: 8,
      type: "auto",
      livecrawl: "fallback",
      contextMaxCharacters: 10000,
    });
  });

  test("honors explicit parameters", async () => {
    const tool = createWebSearchTool();
    if (tool.kind !== "string") throw new Error("expected a string tool");
    await tool.handler(
      {
        query: "q",
        numResults: 3,
        type: "deep",
        livecrawl: "preferred",
        contextMaxCharacters: 500,
      },
      new AbortController().signal,
    );
    expect(calls[0]?.args).toEqual({
      query: "q",
      numResults: 3,
      type: "deep",
      livecrawl: "preferred",
      contextMaxCharacters: 500,
    });
  });

  test("switches to Parallel when configured", async () => {
    process.env.CORBITS_WEB_SEARCH_PROVIDER = "parallel";
    const tool = createWebSearchTool();
    if (tool.kind !== "string") throw new Error("expected a string tool");
    await tool.handler({ query: "corbits code" }, new AbortController().signal);
    expect(connectConfigs[0]?.url).toBe(PARALLEL_MCP_URL);
    expect(calls[0]?.toolName).toBe("web_search");
  });

  test("rejects an empty query before ever connecting", async () => {
    const tool = createWebSearchTool();
    if (tool.kind !== "string") throw new Error("expected a string tool");
    const result = await tool.handler({ query: "" }, new AbortController().signal);
    expect(result).toContain("Error");
    expect(connectConfigs.length).toBe(0);
  });
});
