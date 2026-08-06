import { describe, expect, test } from "bun:test";
import {
  buildGoCatalogEntry,
  fetchGoUsage,
  formatGoUsage,
  isOpenCodeGoURL,
  parseGoAPIError,
  protocolForGoModel,
  resolveGoEndpoint,
  validateGoApiKey,
} from "./index.js";

describe("protocolForGoModel", () => {
  test("returns protocol for known models", () => {
    expect(protocolForGoModel("kimi-k2.7-code")).toBe("chat-completions");
    expect(protocolForGoModel("gpt-5.6-luna")).toBe("responses");
    expect(protocolForGoModel("minimax-m3")).toBe("messages");
  });

  test("returns undefined for unknown models", () => {
    expect(protocolForGoModel("not-a-model")).toBeUndefined();
  });

  test("catalog covers chat-completions and messages at minimum", () => {
    const protocols = new Set(
      ["kimi-k2.7-code", "gpt-5.6-luna", "minimax-m3"].map((id) => protocolForGoModel(id)),
    );
    expect(protocols.has("chat-completions")).toBe(true);
    expect(protocols.has("messages")).toBe(true);
    expect(protocols.has("responses")).toBe(true);
  });
});

describe("resolveGoEndpoint", () => {
  test("routes chat-completions models to openai-compatible base", () => {
    const ep = resolveGoEndpoint("kimi-k2.7-code");
    expect(ep.adapter).toBe("openai-compatible");
    expect(ep.protocol).toBe("chat-completions");
    expect(ep.baseURL).toContain("/zen/go/v1");
  });

  test("routes responses models to openai-responses adapter", () => {
    const ep = resolveGoEndpoint("gpt-5.6-luna");
    expect(ep.adapter).toBe("openai-responses");
    expect(ep.protocol).toBe("responses");
    expect(ep.baseURL).toContain("/zen/go/v1");
  });

  test("routes messages models to anthropic base", () => {
    const ep = resolveGoEndpoint("minimax-m3");
    expect(ep.adapter).toBe("anthropic");
    expect(ep.protocol).toBe("messages");
    expect(ep.baseURL).toBe("https://opencode.ai/zen/go");
  });

  test("unknown models default to chat-completions", () => {
    const ep = resolveGoEndpoint("future-model");
    expect(ep.adapter).toBe("openai-compatible");
    expect(ep.protocol).toBe("chat-completions");
  });
});

describe("validateGoApiKey", () => {
  test("accepts a non-empty printable key", () => {
    expect(validateGoApiKey("sk-test-key-long-enough").ok).toBe(true);
  });

  test("rejects empty, whitespace-only, short, or spaced keys", () => {
    expect(validateGoApiKey("").ok).toBe(false);
    expect(validateGoApiKey("   ").ok).toBe(false);
    expect(validateGoApiKey("short").ok).toBe(false);
    expect(validateGoApiKey("has space").ok).toBe(false);
  });
});

describe("fetchGoUsage / formatGoUsage", () => {
  test("maps 404 to unavailable and formats without throwing", async () => {
    const usage = await fetchGoUsage("sk-test-key", {
      fetchImpl: async () => new Response(null, { status: 404 }),
    });
    expect(usage.status).toBe("unavailable");
    expect(formatGoUsage(usage)).toContain("unavailable");
  });

  test("maps 401 to unauthorized", async () => {
    const usage = await fetchGoUsage("sk-bad", {
      fetchImpl: async () => new Response(null, { status: 401 }),
    });
    expect(usage.status).toBe("unauthorized");
  });

  test("parses ok body and formats rolling window", async () => {
    const usage = await fetchGoUsage("sk-ok", {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            rolling5h: { usagePercent: 42.2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    expect(usage.status).toBe("ok");
    expect(formatGoUsage(usage)).toBe("Go 5h 42%");
  });

  test("network failure degrades to error status", async () => {
    const usage = await fetchGoUsage("sk-ok", {
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });
    expect(usage.status).toBe("error");
    expect(usage.message).toContain("network down");
  });
});

describe("buildGoCatalogEntry", () => {
  test("pre-seeds models and protocol map", () => {
    const entry = buildGoCatalogEntry();
    expect(entry.name).toBe("opencode-go");
    expect(entry.models.length).toBeGreaterThan(0);
    expect(entry.protocols["minimax-m3"]).toBe("messages");
    expect(entry.protocols["kimi-k2.7-code"]).toBe("chat-completions");
  });
});

describe("parseGoAPIError", () => {
  test("classifies GoUsageLimitError on 429 as quota_exhausted", () => {
    const parsed = parseGoAPIError({
      statusCode: 429,
      body: {
        type: "error",
        error: { type: "GoUsageLimitError", message: "subscription quota exceeded" },
        metadata: { workspace: "ws_1" },
      },
      headers: { "retry-after": "120" },
    });
    expect(parsed?.kind).toBe("quota_exhausted");
    expect(parsed?.category).toBe("quota_exhausted");
    expect(parsed?.retryAfterSec).toBe(120);
    expect(parsed?.workspace).toBe("ws_1");
    expect(parsed?.message.toLowerCase()).toContain("quota");
  });

  test("classifies FreeUsageLimitError as quota_exhausted", () => {
    const parsed = parseGoAPIError({
      statusCode: 429,
      body: {
        type: "error",
        error: { type: "FreeUsageLimitError", message: "free usage limit" },
      },
    });
    expect(parsed?.kind).toBe("quota_exhausted");
  });

  test("classifies provider rate limit on 429 as retryable rate_limit", () => {
    const parsed = parseGoAPIError({
      statusCode: 429,
      body: {
        error: {
          message: "Error from provider (Console Go): Provider rate limit exceeded",
          type: "rate_limit_error",
          code: "provider_rate_limit_exceeded",
        },
      },
    });
    expect(parsed?.kind).toBe("rate_limit");
    expect(parsed?.category).toBe("retryable");
  });

  test("treats rate-limit payload on HTTP 400 as rate_limit (gateway quirk)", () => {
    const parsed = parseGoAPIError({
      statusCode: 400,
      body: {
        error: {
          message: "Provider rate limit exceeded",
          type: "rate_limit_error",
          code: "provider_rate_limit_exceeded",
        },
      },
    });
    expect(parsed?.kind).toBe("rate_limit");
    expect(parsed?.category).toBe("retryable");
  });

  test("treats GoUsageLimitError on HTTP 400 as quota_exhausted", () => {
    const parsed = parseGoAPIError({
      statusCode: 400,
      body: {
        type: "error",
        error: { type: "GoUsageLimitError", message: "weekly limit hit" },
      },
    });
    expect(parsed?.kind).toBe("quota_exhausted");
    expect(parsed?.category).toBe("quota_exhausted");
  });

  test("classifies 401 as unauthorized", () => {
    const parsed = parseGoAPIError({
      statusCode: 401,
      body: { error: { message: "invalid key" } },
    });
    expect(parsed?.kind).toBe("unauthorized");
    expect(parsed?.category).toBe("auth");
  });

  test("classifies 403 with usage-limit body as quota_exhausted not unauthorized", () => {
    const parsed = parseGoAPIError({
      statusCode: 403,
      body: {
        type: "error",
        error: { type: "GoUsageLimitError", message: "subscription usage limit reached" },
      },
    });
    expect(parsed?.kind).toBe("quota_exhausted");
    expect(parsed?.category).toBe("quota_exhausted");
  });

  test("classifies 403 without limit markers as unauthorized", () => {
    const parsed = parseGoAPIError({
      statusCode: 403,
      body: { error: { message: "forbidden" } },
    });
    expect(parsed?.kind).toBe("unauthorized");
    expect(parsed?.category).toBe("auth");
  });

  test("bare 429 without body markers is retryable rate_limit", () => {
    const parsed = parseGoAPIError({
      statusCode: 429,
      body: { error: { message: "Too Many Requests" } },
    });
    expect(parsed?.kind).toBe("rate_limit");
    expect(parsed?.category).toBe("retryable");
  });

  test("returns undefined for unrelated 500 bodies", () => {
    const parsed = parseGoAPIError({
      statusCode: 500,
      body: { error: { message: "internal" } },
    });
    expect(parsed).toBeUndefined();
  });
});

describe("isOpenCodeGoURL", () => {
  test("matches zen/go bases", () => {
    expect(isOpenCodeGoURL("https://opencode.ai/zen/go/v1")).toBe(true);
    expect(isOpenCodeGoURL("https://opencode.ai/zen/go")).toBe(true);
    expect(isOpenCodeGoURL("https://opencode.ai/zen/go/v1/")).toBe(true);
    expect(isOpenCodeGoURL("https://opencode.ai/zen/go/")).toBe(true);
    expect(isOpenCodeGoURL("https://api.opencode.ai/zen/go/v1")).toBe(true);
    expect(isOpenCodeGoURL("https://api.openai.com/v1")).toBe(false);
  });

  test("matches path segments case-insensitively", () => {
    expect(isOpenCodeGoURL("https://opencode.ai/Zen/Go/v1")).toBe(true);
    expect(isOpenCodeGoURL("https://opencode.ai/ZEN/GO")).toBe(true);
    expect(isOpenCodeGoURL("https://opencode.ai/zen/GO/v1/")).toBe(true);
  });

  test("rejects host spoofs and path false positives", () => {
    expect(isOpenCodeGoURL("https://not-opencode.ai/zen/go/v1")).toBe(false);
    expect(isOpenCodeGoURL("https://myopencode.ai/zen/go/v1")).toBe(false);
    expect(isOpenCodeGoURL("https://opencode.ai.evil.com/zen/go/v1")).toBe(false);
    expect(isOpenCodeGoURL("https://opencode.ai/zen/goodies")).toBe(false);
    expect(isOpenCodeGoURL("https://opencode.ai/zen/goodies/v1")).toBe(false);
    expect(isOpenCodeGoURL("https://opencode.ai/zen/v1")).toBe(false);
  });

  test("rejects private / non-public hosts (intentional FN; use flag or known name)", () => {
    // Product surface is public-host only — no host allowlist env.
    expect(isOpenCodeGoURL("https://go.internal.example/zen/go/v1")).toBe(false);
    expect(isOpenCodeGoURL("https://localhost:8080/zen/go/v1")).toBe(false);
    expect(isOpenCodeGoURL("http://10.0.0.5/zen/go/v1")).toBe(false);
  });

  test("rejects query-only embeds and path proxies", () => {
    expect(
      isOpenCodeGoURL("https://evil.com/?redirect=https://opencode.ai/zen/go/v1"),
    ).toBe(false);
    expect(
      isOpenCodeGoURL("https://evil.com/proxy/opencode.ai/zen/go/v1"),
    ).toBe(false);
    expect(isOpenCodeGoURL("not a url but mentions opencode.ai/zen/go")).toBe(false);
    expect(isOpenCodeGoURL(undefined)).toBe(false);
    expect(isOpenCodeGoURL("")).toBe(false);
  });
});
