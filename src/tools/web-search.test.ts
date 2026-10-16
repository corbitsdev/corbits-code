import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { withMockedModule } from "../../testkit/mock-module.js";
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
          callResult: async (
            toolName: string,
            args: Record<string, unknown>,
          ) => {
            calls.push({ toolName, args });
            return {
              blocks: [{ type: "text", text: "mock result" }],
              isError: false,
            };
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
  webSearchDefinition,
} = await import("./web-search.js");
const { createAgentToolset } = await import("../agent/tools.js");
const { resolveMcpServers } = await import("../config/index.js");
const { createExaMCPServerConfig } = await import("../mcp/exa.js");
const { createPermissionGate } = await import("../permission/gate.js");

const BUILTIN_EXA_MCP = createExaMCPServerConfig();

// Shared by every tool invocation below: none of these tests abort, so one
// never-aborted signal covers the whole file.
const neverAbortedSignal = new AbortController().signal;

async function connectConfiguredMCP(
  mcpServers?: ResolvedMCPServerConfig[],
): Promise<void> {
  const toolset = await createAgentToolset({
    cwd: process.cwd(),
    permissionGate: createPermissionGate({
      approvals: [],
      interactive: false,
      skipPermissions: true,
      reactorGated: false,
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
    await connectConfiguredMCP(
      resolveMcpServers([{ name: "exa", enabled: false }], undefined),
    );
    expect(connectConfigs).toHaveLength(0);

    await connectConfiguredMCP(
      resolveMcpServers([{ name: "exa", enabled: true }], undefined),
    );
    expect(connectConfigs).toEqual([BUILTIN_EXA_MCP]);
  });
});

describe("resolveWebSearchProvider", () => {
  test("defaults to exa", () => {
    expect(resolveWebSearchProvider({})).toBe("exa");
  });
  test("selects parallel via env override", () => {
    expect(
      resolveWebSearchProvider({ CORBITS_WEB_SEARCH_PROVIDER: "parallel" }),
    ).toBe("parallel");
  });
  test("falls back to exa on an unrecognized value", () => {
    expect(
      resolveWebSearchProvider({ CORBITS_WEB_SEARCH_PROVIDER: "bing" }),
    ).toBe("exa");
  });
});

describe("createWebSearchTool", () => {
  test("calls web_search_exa on the Exa endpoint by default with request defaults", async () => {
    const tool = createWebSearchTool();
    if (tool.kind !== "string") throw new Error("expected a string tool");
    const result = await tool.handler(
      { query: "corbits code" },
      neverAbortedSignal,
    );
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
      neverAbortedSignal,
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
    await tool.handler({ query: "corbits code" }, neverAbortedSignal);
    expect(connectConfigs[0]?.url).toBe(PARALLEL_MCP_URL);
    expect(calls[0]?.toolName).toBe("web_search");
  });

  test("rejects an empty query before ever connecting", async () => {
    const tool = createWebSearchTool();
    if (tool.kind !== "string") throw new Error("expected a string tool");
    const result = await tool.handler({ query: "" }, neverAbortedSignal);
    expect(result).toContain("Error");
    expect(connectConfigs.length).toBe(0);
  });
});

// The served schema must stay the toJsonSchema projection of WebSearchArgs:
// pinning it here asserts the arktype-generated args type remains the single
// source of truth (descriptions flow from the type's @ metadata, not from a
// hand-written JSON copy).
describe("webSearchDefinition.inputSchema", () => {
  test("is generated from WebSearchArgs via toJsonSchema", () => {
    expect(webSearchDefinition.inputSchema).toEqual({
      type: "object",
      properties: {
        query: { type: "string", description: "Search query", minLength: 1 },
        numResults: {
          type: "number",
          description: "Maximum number of results (default 8).",
        },
        type: {
          anyOf: [
            {
              const: "auto",
              description: "Search depth/strategy. Defaults to auto.",
            },
            {
              const: "deep",
              description: "Search depth/strategy. Defaults to auto.",
            },
            {
              const: "fast",
              description: "Search depth/strategy. Defaults to auto.",
            },
          ],
          description: "Search depth/strategy. Defaults to auto.",
        },
        livecrawl: {
          anyOf: [
            {
              const: "fallback",
              description:
                "Whether to prefer or only fall back to a live crawl. Defaults to fallback.",
            },
            {
              const: "preferred",
              description:
                "Whether to prefer or only fall back to a live crawl. Defaults to fallback.",
            },
          ],
          description:
            "Whether to prefer or only fall back to a live crawl. Defaults to fallback.",
        },
        contextMaxCharacters: {
          type: "number",
          description:
            "Cap on returned context length in characters (default 10000).",
        },
      },
      required: ["query"],
    });
  });
});
