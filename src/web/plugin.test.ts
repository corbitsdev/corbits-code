import { describe, expect, test } from "bun:test";
import { webToolsPlugin } from "./plugin.js";
import type { WebProvider, WebResult } from "./types.js";
import type { ToolCall } from "@intx/types/runtime";

function makeCall(name: string, args: Record<string, unknown>): ToolCall {
  return { id: "call-1", name, arguments: args };
}

function mockProvider(overrides: Partial<WebProvider> = {}): WebProvider {
  return {
    name: "mock",
    search: async (): Promise<WebResult[]> => [],
    fetch: async (): Promise<string> => "",
    ...overrides,
  };
}

describe("plugin-only registration", () => {
  test("registers no tools without a provider", () => {
    const plugin = webToolsPlugin();
    expect(plugin.tools ?? []).toEqual([]);
  });

  test("registers web_search and web_fetch when a provider is supplied", () => {
    const plugin = webToolsPlugin({ provider: mockProvider() });
    const names = (plugin.tools ?? []).map((t) => t.definition.name).sort();
    expect(names).toEqual(["web_fetch", "web_search"]);
  });
});

describe("web_search", () => {
  test("delegates to the provider and returns structured results", async () => {
    const provider = mockProvider({
      search: async () => [{ title: "Result One", url: "https://example.com/1", snippet: "snippet" }],
    });
    const plugin = webToolsPlugin({ provider });
    const handler = plugin.tools?.find((t) => t.definition.name === "web_search")?.handler;
    const result = await handler!(makeCall("web_search", { query: "test" }), new AbortController().signal);

    expect(result.isError).not.toBe(true);
    const content = result.content as { results: Array<{ title: string; url: string }> };
    expect(content.results[0]!.title).toBe("Result One");
    expect(content.results[0]!.url).toBe("https://example.com/1");
  });

  test("returns error for empty query", async () => {
    const plugin = webToolsPlugin({ provider: mockProvider() });
    const handler = plugin.tools?.find((t) => t.definition.name === "web_search")?.handler;
    const result = await handler!(makeCall("web_search", { query: "" }), new AbortController().signal);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Error:");
  });
});

describe("web_fetch", () => {
  test("delegates to the provider and returns its content", async () => {
    const provider = mockProvider({ fetch: async () => "# Hello\n\nbody" });
    const plugin = webToolsPlugin({ provider });
    const handler = plugin.tools?.find((t) => t.definition.name === "web_fetch")?.handler;
    const result = await handler!(makeCall("web_fetch", { url: "https://example.com/doc" }), new AbortController().signal);

    expect(result.isError).not.toBe(true);
    const content = result.content as { content: string };
    expect(content.content).toContain("# Hello");
  });

  test("returns error for empty url", async () => {
    const plugin = webToolsPlugin({ provider: mockProvider() });
    const handler = plugin.tools?.find((t) => t.definition.name === "web_fetch")?.handler;
    const result = await handler!(makeCall("web_fetch", { url: "" }), new AbortController().signal);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Error:");
  });

  test("scrubs secrets from provider error messages", async () => {
    const provider = mockProvider({
      fetch: async () => {
        throw new Error("upstream failed for https://example.com/?api_key=secret123");
      },
    });
    const plugin = webToolsPlugin({ provider });
    const handler = plugin.tools?.find((t) => t.definition.name === "web_fetch")?.handler;
    const result = await handler!(makeCall("web_fetch", { url: "https://example.com/doc" }), new AbortController().signal);

    expect(result.isError).toBe(true);
    expect(result.content).not.toContain("secret123");
    expect(result.content).toContain("api_key=[REDACTED]");
  });
});
