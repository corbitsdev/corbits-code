import { afterEach, describe, expect, test } from "bun:test";

import {
  discoverOllamaModels,
  isOllamaProviderId,
  normalizeOllamaRootURL,
  ollamaDiscoveryFailureLine,
  ollamaOpenAIBaseURL,
  type OllamaDiscoveryState,
} from "./ollama.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Ollama provider identity", () => {
  test("recognizes the reserved family without matching unrelated keyless providers", () => {
    expect(isOllamaProviderId("ollama")).toBe(true);
    expect(isOllamaProviderId("ollama/workstation")).toBe(true);
    expect(isOllamaProviderId("local")).toBe(false);
    expect(isOllamaProviderId("ollama-cloud")).toBe(false);
  });
});

describe("ollamaOpenAIBaseURL", () => {
  test("projects a root URL to exactly one /v1", () => {
    expect(ollamaOpenAIBaseURL("http://localhost:11434")).toBe("http://localhost:11434/v1");
    expect(ollamaOpenAIBaseURL("http://localhost:11434/")).toBe("http://localhost:11434/v1");
  });

  test("strips a pasted or legacy /v1 before re-appending once", () => {
    expect(normalizeOllamaRootURL("http://localhost:11434/v1")).toBe("http://localhost:11434");
    expect(normalizeOllamaRootURL("http://localhost:11434/v1/")).toBe("http://localhost:11434");
    expect(ollamaOpenAIBaseURL("http://localhost:11434/v1")).toBe("http://localhost:11434/v1");
    expect(ollamaOpenAIBaseURL("http://localhost:11434/v1/")).toBe("http://localhost:11434/v1");
  });

  test("rejects non-root paths other than /v1", () => {
    expect(() => ollamaOpenAIBaseURL("http://localhost:11434/team")).toThrow(
      "expected a server root without a path",
    );
    expect(() => ollamaOpenAIBaseURL("http://localhost:11434/api/tags")).toThrow(
      "expected a server root without a path",
    );
    expect(() => normalizeOllamaRootURL("http://localhost:11434/api/tags")).toThrow(
      "expected a server root without a path",
    );
  });
});

describe("ollamaDiscoveryFailureLine", () => {
  test("keeps unreachable as not running and surfaces HTTP and URL errors", () => {
    expect(ollamaDiscoveryFailureLine({ status: "empty" })).toBe(
      "Ollama is running, but no models are installed",
    );
    expect(
      ollamaDiscoveryFailureLine({ status: "unavailable", message: "connection refused" }),
    ).toBe("Ollama is not running");
    expect(
      ollamaDiscoveryFailureLine({ status: "unavailable", message: "Ollama returned HTTP 503" }),
    ).toBe("Ollama returned HTTP 503");
    expect(
      ollamaDiscoveryFailureLine({ status: "malformed", message: "data must be an array" }),
    ).toBe("Ollama returned an invalid models response");
    expect(
      ollamaDiscoveryFailureLine({
        status: "malformed",
        message:
          'Invalid Ollama URL "http://localhost:11434/team": expected a server root without a path.',
      }),
    ).toContain("Invalid Ollama URL");
  });
});

describe("discoverOllamaModels", () => {
  test("requests the OpenAI models endpoint and validates model ids", async () => {
    const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("http://localhost:11434/v1/models");
      expect(init?.method).toBe("GET");
      return Response.json({ data: [{ id: "qwen3" }, { id: "deepseek-r1" }] });
    };
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(discoverOllamaModels({ rootURL: "http://localhost:11434/" })).resolves.toEqual({
      status: "models",
      models: ["qwen3", "deepseek-r1"],
    });
  });

  test("accepts a pasted /v1 root without doubling the path", async () => {
    const fetchMock = async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("http://localhost:11434/v1/models");
      return Response.json({ data: [{ id: "llama3" }] });
    };
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(discoverOllamaModels({ rootURL: "http://localhost:11434/v1" })).resolves.toEqual({
      status: "models",
      models: ["llama3"],
    });
  });

  test("distinguishes empty, unavailable, HTTP, and malformed responses", async () => {
    const cases: {
      response: () => Promise<Response>;
      expected: OllamaDiscoveryState["status"];
    }[] = [
      { response: async () => Response.json({ data: [] }), expected: "empty" },
      { response: async () => new Response("no", { status: 503 }), expected: "unavailable" },
      { response: async () => Response.json({ models: [] }), expected: "malformed" },
    ];

    for (const item of cases) {
      globalThis.fetch = item.response as unknown as typeof fetch;
      expect((await discoverOllamaModels({ rootURL: "http://localhost:11434" })).status).toBe(
        item.expected,
      );
    }

    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    expect((await discoverOllamaModels({ rootURL: "http://localhost:11434" })).status).toBe(
      "unavailable",
    );
  });
});
