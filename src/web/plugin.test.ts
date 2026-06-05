import { describe, expect, test, beforeEach } from "bun:test";
import { webToolsPlugin } from "./plugin.js";
import { resetWebProvider } from "./providers/index.js";
import type { ToolCall } from "@intx/types/runtime";

beforeEach(() => {
  resetWebProvider();
});

function makeCall(name: string, args: Record<string, unknown>): ToolCall {
  return { id: "call-1", name, arguments: args };
}

function mockResponse(body: string, contentType: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": contentType },
  });
}

describe("web_search", () => {
  test("returns structured results on success", async () => {
    const plugin = webToolsPlugin({
      localOptions: {
        fetchImpl: (async () =>
          mockResponse(
            `<html><body>` +
            `<a href="https://example.com/result1">Result One</a>` +
            `<p>This is snippet one.</p>` +
            `<a href="https://example.com/result2">Result Two</a>` +
            `<p>This is snippet two.</p>` +
            `</body></html>`,
            "text/html",
          )) as unknown as typeof fetch,
      },
    });
    const handler = plugin.tools?.find((t) => t.definition.name === "web_search")?.handler;
    expect(handler).toBeDefined();

    const result = await handler!(makeCall("web_search", { query: "test" }), new AbortController().signal);

    expect(result.isError).not.toBe(true);
    expect(typeof result.content).toBe("object");
    const content = result.content as { results: Array<{ title: string; url: string; snippet: string }> };
    expect(content.results.length).toBeGreaterThan(0);
    expect(content.results[0]!.title).toBe("Result One");
    expect(content.results[0]!.url).toBe("https://example.com/result1");
  });

  test("returns empty results when parsing yields nothing", async () => {
    const plugin = webToolsPlugin({
      localOptions: {
        fetchImpl: (async () => mockResponse("<html><body>No results here</body></html>", "text/html")) as unknown as typeof fetch,
      },
    });
    const handler = plugin.tools?.find((t) => t.definition.name === "web_search")?.handler;
    const result = await handler!(makeCall("web_search", { query: "test" }), new AbortController().signal);

    expect(result.isError).not.toBe(true);
    const content = result.content as { results: unknown[] };
    expect(content.results).toEqual([]);
  });

  test("returns error for empty query", async () => {
    const plugin = webToolsPlugin();
    const handler = plugin.tools?.find((t) => t.definition.name === "web_search")?.handler;
    const result = await handler!(makeCall("web_search", { query: "" }), new AbortController().signal);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Error:");
  });
});

describe("web_fetch", () => {
  test("returns markdown content when server serves text/markdown", async () => {
    const plugin = webToolsPlugin({
      localOptions: {
        fetchImpl: (async () => mockResponse("# Hello\n\nThis is markdown.", "text/markdown")) as unknown as typeof fetch,
      },
    });
    const handler = plugin.tools?.find((t) => t.definition.name === "web_fetch")?.handler;

    const result = await handler!(makeCall("web_fetch", { url: "https://example.com/doc" }), new AbortController().signal);

    expect(result.isError).not.toBe(true);
    const content = result.content as { content: string };
    expect(content.content).toContain("# Hello");
  });

  test("converts HTML to markdown when server serves text/html", async () => {
    const plugin = webToolsPlugin({
      localOptions: {
        fetchImpl: (async () => mockResponse("<h1>Hello</h1><p>This is HTML.</p>", "text/html")) as unknown as typeof fetch,
      },
    });
    const handler = plugin.tools?.find((t) => t.definition.name === "web_fetch")?.handler;

    const result = await handler!(makeCall("web_fetch", { url: "https://example.com/page" }), new AbortController().signal);

    expect(result.isError).not.toBe(true);
    const content = result.content as { content: string };
    expect(content.content).toContain("# Hello");
  });

  test("passes through plain text", async () => {
    const plugin = webToolsPlugin({
      localOptions: {
        fetchImpl: (async () => mockResponse("Plain text content", "text/plain")) as unknown as typeof fetch,
      },
    });
    const handler = plugin.tools?.find((t) => t.definition.name === "web_fetch")?.handler;

    const result = await handler!(makeCall("web_fetch", { url: "https://example.com/plain" }), new AbortController().signal);

    expect(result.isError).not.toBe(true);
    const content = result.content as { content: string };
    expect(content.content).toContain("Plain text content");
  });

  test("returns error for blocked URL", async () => {
    const plugin = webToolsPlugin();
    const handler = plugin.tools?.find((t) => t.definition.name === "web_fetch")?.handler;

    const result = await handler!(makeCall("web_fetch", { url: "http://localhost:8080/internal" }), new AbortController().signal);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("blocked by policy");
  });

  test("returns error when a redirect targets a blocked URL", async () => {
    const plugin = webToolsPlugin({
      localOptions: {
        fetchImpl: (async () =>
          new Response("", {
            status: 302,
            headers: { location: "http://169.254.169.254/latest/meta-data/" },
          })) as unknown as typeof fetch,
      },
    });
    const handler = plugin.tools?.find((t) => t.definition.name === "web_fetch")?.handler;

    const result = await handler!(makeCall("web_fetch", { url: "https://example.com/start" }), new AbortController().signal);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("redirect blocked by policy");
  });

  test("returns error for 5xx response", async () => {
    const plugin = webToolsPlugin({
      localOptions: {
        fetchImpl: (async () => mockResponse("Internal Server Error", "text/plain", 500)) as unknown as typeof fetch,
      },
    });
    const handler = plugin.tools?.find((t) => t.definition.name === "web_fetch")?.handler;

    const result = await handler!(makeCall("web_fetch", { url: "https://example.com/error" }), new AbortController().signal);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Error:");
  });

  test("returns error for empty url", async () => {
    const plugin = webToolsPlugin();
    const handler = plugin.tools?.find((t) => t.definition.name === "web_fetch")?.handler;

    const result = await handler!(makeCall("web_fetch", { url: "" }), new AbortController().signal);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Error:");
  });

  test("no secrets leak in error content", async () => {
    const plugin = webToolsPlugin();
    const handler = plugin.tools?.find((t) => t.definition.name === "web_fetch")?.handler;

    const result = await handler!(
      makeCall("web_fetch", { url: "http://localhost:8080/internal?api_key=secret123" }),
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).not.toContain("secret123");
    expect(result.content).not.toContain("api_key=secret123");
  });

  test("no secrets leak from provider error content", async () => {
    const plugin = webToolsPlugin({
      localOptions: {
        fetchImpl: (async () => {
          throw new Error("upstream failed for https://example.com/?api_key=secret123");
        }) as unknown as typeof fetch,
      },
    });
    const handler = plugin.tools?.find((t) => t.definition.name === "web_fetch")?.handler;

    const result = await handler!(makeCall("web_fetch", { url: "https://example.com/doc" }), new AbortController().signal);

    expect(result.isError).toBe(true);
    expect(result.content).not.toContain("secret123");
    expect(result.content).toContain("api_key=[REDACTED]");
  });
});
