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
});

