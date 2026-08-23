import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const calls: { toolName: string; args: Record<string, unknown> }[] = [];
let connectConfigs: { name: string; url?: string }[] = [];

// Bun mutates the imported namespace object in place when a module is
// mocked, so the capture is shallow-copied immediately -- holding onto the
// live namespace would turn into the mocked exports as soon as mock.module
// below runs, making the afterAll restore a no-op. The mock also needs to
// spread the real module rather than replace it outright, or any other
// export (unwrapToolContent, connectMCPServers) disappears for the rest of
// the process for every file that runs after this one.
const realClient = { ...(await import("../mcp/client.js")) };

mock.module("../mcp/client.js", () => ({
  ...realClient,
  connectMCPServer: async (config: { name: string; url?: string }) => {
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
}));

afterAll(() => {
  mock.module("../mcp/client.js", () => realClient);
});

const {
  createWebSearchTool,
  disposeWebSearchClients,
  resolveWebSearchProvider,
  EXA_MCP_URL,
  PARALLEL_MCP_URL,
} = await import("./web-search.js");

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
