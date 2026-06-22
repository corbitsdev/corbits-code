import { describe, expect, test } from "bun:test";
import createWebProvider from "./index.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createWebProvider options validation", () => {
  test("throws when apiKey is missing", () => {
    expect(() => createWebProvider({})).toThrow(/apiKey/);
  });

  test("throws when apiKey is empty", () => {
    expect(() => createWebProvider({ apiKey: "" })).toThrow(/apiKey/);
  });

  test("returns a WebProvider with name, search, fetch", () => {
    const provider = createWebProvider({ apiKey: "k" });
    expect(provider.name).toBe("exa");
    expect(typeof provider.search).toBe("function");
    expect(typeof provider.fetch).toBe("function");
  });
});

describe("search", () => {
  test("maps Exa results into WebResult shape", async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        results: [
          {
            title: "Result One",
            url: "https://example.com/1",
            text: "Snippet one",
            publishedDate: "2024-01-01",
            author: "Author A",
            score: 0.9,
          },
        ],
      })) as unknown as typeof fetch;

    const provider = createWebProvider({ apiKey: "k", fetchImpl });
    const results = await provider.search("test", new AbortController().signal);

    expect(results.length).toBe(1);
    expect(results[0]!.title).toBe("Result One");
    expect(results[0]!.url).toBe("https://example.com/1");
    expect(results[0]!.snippet).toBe("Snippet one");
    expect(results[0]!.extra).toEqual({
      publishedDate: "2024-01-01",
      author: "Author A",
      score: 0.9,
    });
  });

  test("skips malformed result items", async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        results: [{ title: "Good", url: "https://example.com" }, { nope: true }],
      })) as unknown as typeof fetch;

    const provider = createWebProvider({ apiKey: "k", fetchImpl });
    const results = await provider.search("test", new AbortController().signal);

    expect(results.length).toBe(1);
    expect(results[0]!.snippet).toBe("");
  });

  test("throws on non-ok response", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const provider = createWebProvider({ apiKey: "k", fetchImpl });

    await expect(provider.search("test", new AbortController().signal)).rejects.toThrow(/401/);
  });

  test("throws on unrecognizable response shape", async () => {
    const fetchImpl = (async () => jsonResponse({ unexpected: true })) as unknown as typeof fetch;
    const provider = createWebProvider({ apiKey: "k", fetchImpl });

    await expect(provider.search("test", new AbortController().signal)).rejects.toThrow(
      /unrecognizable/,
    );
  });
});

describe("fetch", () => {
  test("returns body text on success", async () => {
    const fetchImpl = (async () =>
      new Response("# Hello", {
        status: 200,
        headers: { "content-type": "text/markdown" },
      })) as unknown as typeof fetch;

    const provider = createWebProvider({ apiKey: "k", fetchImpl });
    const content = await provider.fetch("https://example.com", new AbortController().signal);
    expect(content).toBe("# Hello");
  });

  test("throws on non-ok response", async () => {
    const fetchImpl = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    const provider = createWebProvider({ apiKey: "k", fetchImpl });

    await expect(
      provider.fetch("https://example.com", new AbortController().signal),
    ).rejects.toThrow(/500/);
  });
});
