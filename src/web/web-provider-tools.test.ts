import { describe, expect, test } from "bun:test";
import { createWebSearchTool, formatWebResults } from "../tools/web-search.js";
import { createWebFetchTool } from "../tools/web-fetch.js";
import { createAgentToolset } from "../agent/tools.js";
import { createPermissionGate } from "../permission/gate.js";
import type { WebProvider, WebResult } from "./types.js";

// CL-9885: the resolved kind:"web" plugin must back web_search/web_fetch,
// not just brand their display names. Core backends stay the fallback.

const neverAbortedSignal = new AbortController().signal;

interface StubCalls {
  searches: string[];
  fetches: string[];
}

function stubProvider(
  stub: {
    searchImpl?: (query: string) => Promise<WebResult[]>;
    fetchImpl?: (url: string) => Promise<string>;
  } = {},
): { provider: WebProvider; calls: StubCalls } {
  const calls: StubCalls = { searches: [], fetches: [] };
  const provider: WebProvider = {
    name: "Stub",
    search: async (query: string, _signal: AbortSignal) => {
      calls.searches.push(query);
      if (stub.searchImpl !== undefined) return stub.searchImpl(query);
      return [{ title: "t", url: "https://example.com", snippet: "s" }];
    },
    fetch: async (url: string, _signal: AbortSignal) => {
      calls.fetches.push(url);
      if (stub.fetchImpl !== undefined) return stub.fetchImpl(url);
      return "stub body";
    },
  };
  return { provider, calls };
}

describe("formatWebResults", () => {
  test("empty results stay in the empty-but-ok taxonomy", () => {
    expect(formatWebResults([])).toBe("No results.");
  });

  test("renders title, url, and snippet per result", () => {
    expect(
      formatWebResults([
        { title: "A", url: "https://a.example", snippet: "alpha" },
        { title: "B", url: "https://b.example", snippet: "beta" },
      ]),
    ).toBe("- A (https://a.example)\n  alpha\n- B (https://b.example)\n  beta");
  });
});

describe("createWebSearchTool with a web provider", () => {
  test("delegates the query to the provider", async () => {
    const { provider, calls } = stubProvider();
    const tool = createWebSearchTool(provider);
    if (tool.kind !== "string") throw new Error("expected a string tool");
    const result = await tool.handler({ query: "q" }, neverAbortedSignal);
    expect(calls.searches).toEqual(["q"]);
    expect(result).toBe("- t (https://example.com)\n  s");
  });

  test("provider failure is an Error result, not a throw", async () => {
    const { provider } = stubProvider({
      searchImpl: async () => {
        throw new Error("down");
      },
    });
    const tool = createWebSearchTool(provider);
    if (tool.kind !== "string") throw new Error("expected a string tool");
    const result = await tool.handler({ query: "q" }, neverAbortedSignal);
    expect(result).toBe("Error: web_search (Stub) failed: down");
  });

  test("an empty query never reaches the provider", async () => {
    const { provider, calls } = stubProvider();
    const tool = createWebSearchTool(provider);
    if (tool.kind !== "string") throw new Error("expected a string tool");
    const result = await tool.handler({ query: "" }, neverAbortedSignal);
    expect(result).toContain("Error");
    expect(calls.searches).toEqual([]);
  });
});

describe("createWebFetchTool with a web provider", () => {
  test("delegates the url to the provider", async () => {
    const { provider, calls } = stubProvider();
    const tool = createWebFetchTool({ provider });
    if (tool.kind !== "string") throw new Error("expected a string tool");
    const result = await tool.handler(
      { url: "https://example.com" },
      neverAbortedSignal,
    );
    expect(calls.fetches).toEqual(["https://example.com"]);
    expect(result).toBe("stub body");
  });

  test("provider failure is an Error result, not a throw", async () => {
    const { provider } = stubProvider({
      fetchImpl: async () => {
        throw new Error("down");
      },
    });
    const tool = createWebFetchTool({ provider });
    if (tool.kind !== "string") throw new Error("expected a string tool");
    const result = await tool.handler(
      { url: "https://example.com" },
      neverAbortedSignal,
    );
    expect(result).toBe("Error: web_fetch (Stub) failed: down");
  });

  test("invalid args never reach the provider", async () => {
    const { provider, calls } = stubProvider();
    const tool = createWebFetchTool({ provider });
    if (tool.kind !== "string") throw new Error("expected a string tool");
    const result = await tool.handler({}, neverAbortedSignal);
    expect(result).toContain("Error");
    expect(calls.fetches).toEqual([]);
  });

  test("a loopback URL never reaches the provider", async () => {
    const { provider, calls } = stubProvider();
    const tool = createWebFetchTool({ provider });
    if (tool.kind !== "string") throw new Error("expected a string tool");
    const result = await tool.handler(
      { url: "http://127.0.0.1/" },
      neverAbortedSignal,
    );
    expect(result).toContain("Error");
    expect(calls.fetches).toEqual([]);
  });

  test("a file URL never reaches the provider", async () => {
    const { provider, calls } = stubProvider();
    const tool = createWebFetchTool({ provider });
    if (tool.kind !== "string") throw new Error("expected a string tool");
    const result = await tool.handler(
      { url: "file:///etc/passwd" },
      neverAbortedSignal,
    );
    expect(result).toContain("Error");
    expect(calls.fetches).toEqual([]);
  });
});

describe("createAgentToolset with webProvider", () => {
  test("web_search and web_fetch run on the selected provider", async () => {
    const { provider, calls } = stubProvider();
    const toolset = await createAgentToolset({
      cwd: process.cwd(),
      permissionGate: createPermissionGate({
        approvals: [],
        interactive: false,
        skipPermissions: true,
        reactorGated: false,
      }),
      onOperatorGate: async () => ({ kind: "cancel" }),
      webProvider: provider,
    });
    try {
      const searchResult = await toolset.dynamicRunner.run(
        { id: "s1", name: "web_search", arguments: { query: "q" } },
        neverAbortedSignal,
      );
      const fetchResult = await toolset.dynamicRunner.run(
        {
          id: "f1",
          name: "web_fetch",
          arguments: { url: "https://example.com" },
        },
        neverAbortedSignal,
      );
      expect(calls.searches).toEqual(["q"]);
      expect(calls.fetches).toEqual(["https://example.com"]);
      expect(searchResult.content).toBe("- t (https://example.com)\n  s");
      expect(fetchResult.content).toBe("stub body");
    } finally {
      await toolset.dispose();
    }
  });
});
