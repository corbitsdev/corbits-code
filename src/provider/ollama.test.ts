import { afterEach, describe, expect, test } from "bun:test";

import {
  discoverOllamaModels,
  isOllamaProviderId,
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

  test("rejects non-root paths instead of ambiguously appending /v1", () => {
    expect(() => ollamaOpenAIBaseURL("http://localhost:11434/v1")).toThrow(
      "expected a server root without a path",
    );
    expect(() => ollamaOpenAIBaseURL("http://localhost:11434/team")).toThrow(
      "expected a server root without a path",
    );
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
