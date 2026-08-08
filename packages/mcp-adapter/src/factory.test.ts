import { afterEach, describe, expect, mock, test } from "bun:test";
import * as connectModule from "./connect.js";

const realConnect = { ...connectModule };
const SEARCH_DEF = { name: "search", description: "Search.", inputSchema: { type: "object", properties: {} } };

afterEach(() => {
  mock.restore();
});

describe("defineMcpToolFactory", () => {
  test("is structurally an AnnotatedToolFactory: callable, id, requires", async () => {
    const { defineMcpToolFactory } = await import("./factory.js");
    const factory = defineMcpToolFactory({
      id: "@corbits/test-mcp/test",
      serverName: "test-seam",
      url: "https://example.invalid/mcp",
      toolDeclarations: [SEARCH_DEF],
      clientName: "corbits-code-test",
    });
    expect(typeof factory).toBe("function");
    expect(factory.id).toBe("@corbits/test-mcp/test");
    expect(Array.isArray(factory.requires)).toBe(true);
    expect(factory.requires.every((r) => typeof r === "string")).toBe(true);
  });

  test("constructing the bundle does not connect; definitions are populated synchronously", async () => {
    const connectSpy = mock(() => new Promise(() => undefined));
    mock.module("./connect.js", () => ({ ...realConnect, connectHostedMcpServer: connectSpy }));
    const { defineMcpToolFactory } = await import("./factory.js");

    const factory = defineMcpToolFactory({
      id: "@corbits/test-mcp/test",
      serverName: "test-seam",
      url: "https://example.invalid/mcp",
      toolDeclarations: [SEARCH_DEF],
      clientName: "corbits-code-test",
    });

    const bundle = factory({} as never);
    expect(bundle.definitions).toEqual([SEARCH_DEF]);
    expect(connectSpy).not.toHaveBeenCalled();
  });

  // This exercises factory.ts's contract with connect.ts (call onAuthURL,
  // then reject -> factory surfaces the URL in the tool result), not
  // connect.ts's real OAuth behavior. In production, a first-time
  // authorization blocks this call until the browser round-trip
  // completes or the tool call's signal aborts it (see the comment on
  // `ensureConnected(signal)` in factory.ts); connect.ts/oauth-
  // provider.ts/callback-server.ts's real network and OAuth paths have
  // no test coverage yet.
  test("first run() triggers a lazy connect and surfaces the auth URL when required", async () => {
    const connectSpy = mock(
      (_serverName: string, _url: string, options: { onAuthURL: (name: string, url: string) => void }) => {
        options.onAuthURL("test-seam", "https://example.invalid/authorize?state=fake-state");
        return Promise.reject(new Error("Unauthorized"));
      },
    );
    mock.module("./connect.js", () => ({ ...realConnect, connectHostedMcpServer: connectSpy }));
    const { defineMcpToolFactory } = await import("./factory.js");

    const factory = defineMcpToolFactory({
      id: "@corbits/test-mcp/test",
      serverName: "test-seam",
      url: "https://example.invalid/mcp",
      toolDeclarations: [SEARCH_DEF],
      clientName: "corbits-code-test",
    });
    const bundle = factory({} as never);

    expect(connectSpy).not.toHaveBeenCalled();
    const result = await bundle.run({ id: "call-1", name: "search", arguments: {} }, new AbortController().signal);
    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("https://example.invalid/authorize");
  });

  test("run() threads its own abort signal through to the connect call", async () => {
    let seenSignal: AbortSignal | undefined;
    const connectSpy = mock((_serverName: string, _url: string, options: { signal?: AbortSignal }) => {
      seenSignal = options.signal;
      return Promise.reject(new Error("stop after capturing signal"));
    });
    mock.module("./connect.js", () => ({ ...realConnect, connectHostedMcpServer: connectSpy }));
    const { defineMcpToolFactory } = await import("./factory.js");

    const factory = defineMcpToolFactory({
      id: "@corbits/test-mcp/test",
      serverName: "test-seam",
      url: "https://example.invalid/mcp",
      toolDeclarations: [SEARCH_DEF],
      clientName: "corbits-code-test",
    });
    const controller = new AbortController();
    await factory({} as never).run({ id: "1", name: "search", arguments: {} }, controller.signal);
    expect(seenSignal).toBe(controller.signal);
  });

  test("optional API key is appended as a query param only when the env var is set", async () => {
    let seenUrl: string | undefined;
    const connectSpy = mock((_serverName: string, url: string) => {
      seenUrl = url;
      return Promise.reject(new Error("stop after capturing url"));
    });
    mock.module("./connect.js", () => ({ ...realConnect, connectHostedMcpServer: connectSpy }));
    const { defineMcpToolFactory } = await import("./factory.js");

    const withoutKey = defineMcpToolFactory({
      id: "@corbits/test-mcp/test",
      serverName: "test-seam",
      url: "https://example.invalid/mcp",
      toolDeclarations: [SEARCH_DEF],
      clientName: "corbits-code-test",
      apiKeyEnvVar: "CORBITS_TEST_MCP_API_KEY",
      apiKeyQueryParam: "apiKey",
    });
    await withoutKey({} as never).run({ id: "1", name: "search", arguments: {} }, new AbortController().signal);
    expect(seenUrl).toBe("https://example.invalid/mcp");

    process.env.CORBITS_TEST_MCP_API_KEY = "fake-test-key-not-real";
    try {
      const withKey = defineMcpToolFactory({
        id: "@corbits/test-mcp/test",
        serverName: "test-seam",
        url: "https://example.invalid/mcp",
        toolDeclarations: [SEARCH_DEF],
        clientName: "corbits-code-test",
        apiKeyEnvVar: "CORBITS_TEST_MCP_API_KEY",
        apiKeyQueryParam: "apiKey",
      });
      await withKey({} as never).run({ id: "2", name: "search", arguments: {} }, new AbortController().signal);
      expect(seenUrl).toBe("https://example.invalid/mcp?apiKey=fake-test-key-not-real");
    } finally {
      delete process.env.CORBITS_TEST_MCP_API_KEY;
    }
  });

  test("a run() after a failed connect retries instead of replaying the stale rejection", async () => {
    let callCount = 0;
    const connectSpy = mock(() => {
      callCount += 1;
      return Promise.reject(new Error(`connect failure #${callCount}`));
    });
    mock.module("./connect.js", () => ({ ...realConnect, connectHostedMcpServer: connectSpy }));
    const { defineMcpToolFactory } = await import("./factory.js");

    const factory = defineMcpToolFactory({
      id: "@corbits/test-mcp/test",
      serverName: "test-seam",
      url: "https://example.invalid/mcp",
      toolDeclarations: [SEARCH_DEF],
      clientName: "corbits-code-test",
    });
    const bundle = factory({} as never);

    const result1 = await bundle.run({ id: "1", name: "search", arguments: {} }, new AbortController().signal);
    expect(String(result1.content)).toContain("connect failure #1");

    const result2 = await bundle.run({ id: "2", name: "search", arguments: {} }, new AbortController().signal);
    expect(callCount).toBe(2);
    expect(String(result2.content)).toContain("connect failure #2");
  });

  test("dispose() racing an in-flight connect still closes it once it resolves", async () => {
    let closeCalled = 0;
    let resolveConnect: (v: unknown) => void = () => undefined;
    const connectSpy = mock(
      () =>
        new Promise((resolve) => {
          resolveConnect = resolve;
        }),
    );
    mock.module("./connect.js", () => ({ ...realConnect, connectHostedMcpServer: connectSpy }));
    const { defineMcpToolFactory } = await import("./factory.js");

    const factory = defineMcpToolFactory({
      id: "@corbits/test-mcp/test",
      serverName: "test-seam",
      url: "https://example.invalid/mcp",
      toolDeclarations: [SEARCH_DEF],
      clientName: "corbits-code-test",
    });
    const bundle = factory({} as never);

    const runPromise = bundle.run({ id: "1", name: "search", arguments: {} }, new AbortController().signal);
    await bundle.dispose?.();
    resolveConnect({
      serverName: "test-seam",
      tools: [],
      call: async () => "",
      close: async () => {
        closeCalled += 1;
      },
    });
    await runPromise;

    expect(closeCalled).toBe(1);
  });
});

