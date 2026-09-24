import { describe, expect, test } from "bun:test";
import {
  buildAnthropicSource,
  buildGoSource,
  buildZenSource,
} from "../config/index.js";
import {
  anthropicCacheWriteAt,
  cacheTtlMsFor,
  resumeCacheWriteSeed,
} from "./cache-ttl.js";

const MINUTE_MS = 60_000;

describe("cacheTtlMsFor", () => {
  test("allows idle recompress only for the published Anthropic 5-minute window", () => {
    expect(cacheTtlMsFor("anthropic/claude-opus-4-6")).toBe(5 * MINUTE_MS);
    expect(cacheTtlMsFor("zen-messages/claude-opus-4-6")).toBe(5 * MINUTE_MS);
    expect(cacheTtlMsFor("opencode-go-messages/claude-opus-4-6")).toBe(
      5 * MINUTE_MS,
    );
  });

  test("disables providers whose expiry is unpublished or longer than 5 minutes", () => {
    expect(cacheTtlMsFor("openai-responses/gpt-5.6")).toBeUndefined();
    expect(cacheTtlMsFor("codex-responses/gpt-5.6")).toBeUndefined();
    expect(cacheTtlMsFor("openai-compatible/custom")).toBeUndefined();
    expect(cacheTtlMsFor("xai/thegreataxios")).toBeUndefined();
    expect(cacheTtlMsFor("gemini/gemini-3-pro")).toBeUndefined();
    expect(cacheTtlMsFor("deepseek/deepseek-chat")).toBeUndefined();
    expect(cacheTtlMsFor("ollama/llama3.1")).toBeUndefined();
    expect(cacheTtlMsFor(undefined)).toBeUndefined();
    expect(cacheTtlMsFor("")).toBeUndefined();
  });

  test("keys ollama off production LastCycleSource, not a slash-form model", () => {
    expect(
      cacheTtlMsFor({
        sourceId: "ollama/default",
        provider: "openai-compatible",
        model: "llama3",
      }),
    ).toBeUndefined();
  });

  test("maps a bare Anthropic LastCycleSource and leaves Codex quiet", () => {
    expect(
      cacheTtlMsFor({
        provider: "anthropic",
        model: "claude-opus-4-6",
      }),
    ).toBe(5 * MINUTE_MS);
    expect(
      cacheTtlMsFor({
        provider: "codex-responses",
        model: "gpt-5.6-luna",
      }),
    ).toBeUndefined();
  });

  test("does not inherit a window from the model family or an unknown provider", () => {
    expect(cacheTtlMsFor("proxy-acme/grok-4")).toBeUndefined();
    expect(cacheTtlMsFor("proxy-acme/gemini-3-pro")).toBeUndefined();
    expect(cacheTtlMsFor("proxy-acme/claude-opus-4-6")).toBeUndefined();
    // The provider segment wins: an openai-compatible account fronting
    // Claude is not the Anthropic messages protocol.
    expect(cacheTtlMsFor("openai-compatible/claude-opus-4-6")).toBeUndefined();
    expect(cacheTtlMsFor("bifrost/some-model")).toBeUndefined();
    expect(cacheTtlMsFor("unknown-id")).toBeUndefined();
  });
});

describe("anthropic cache-write stamp", () => {
  test("stamps only Anthropic-protocol identities", () => {
    expect(anthropicCacheWriteAt("anthropic:claude-opus-4-6", 10)).toBe(10);
    expect(anthropicCacheWriteAt({ provider: "zen-messages" }, 10)).toBe(10);
    expect(anthropicCacheWriteAt({ provider: "openai" }, 10)).toBeUndefined();
    expect(anthropicCacheWriteAt(undefined, 10)).toBeUndefined();
  });

  test("resume seed requires both the stored model and the live provider", () => {
    expect(
      resumeCacheWriteSeed({
        at: 10,
        storedModel: "anthropic:claude-opus-4-6",
        liveProvider: "anthropic",
        liveProtocol: "anthropic",
      }),
    ).toEqual({ at: 10, model: "anthropic:claude-opus-4-6" });
    expect(
      resumeCacheWriteSeed({
        at: 10,
        storedModel: "openai:gpt-5.6",
        liveProvider: "openai",
        liveProtocol: "openai",
      }),
    ).toBeUndefined();
    expect(
      resumeCacheWriteSeed({
        at: 10,
        storedModel: "anthropic:claude-opus-4-6",
        liveProvider: "openai",
        liveProtocol: "openai",
      }),
    ).toBeUndefined();
    expect(
      resumeCacheWriteSeed({
        at: undefined,
        storedModel: "anthropic:claude-opus-4-6",
        liveProvider: "anthropic",
        liveProtocol: "anthropic",
      }),
    ).toBeUndefined();
  });

  test("catalog ids that speak the Anthropic protocol still return the stamp", () => {
    const at = 10;
    const sources = [
      buildZenSource({
        id: "zen",
        model: "claude-opus-4-6",
        sessionId: "sess-zen",
      }),
      buildGoSource({
        id: "opencode-go",
        model: "minimax-m3",
        sessionId: "sess-go",
      }),
      buildAnthropicSource({
        id: "acme",
        baseURL: "https://example.invalid",
        model: "claude-opus-4-6",
      }),
    ];
    for (const source of sources) {
      expect(source.id).not.toBe(source.provider);
      const storedModel = `${source.id}:${source.model}`;
      expect(
        resumeCacheWriteSeed({
          at,
          storedModel,
          liveProvider: source.id,
          liveProtocol: source.provider,
        }),
      ).toEqual({ at, model: `${source.provider}:${source.model}` });
    }

    const gemini = buildZenSource({
      id: "zen",
      model: "gemini-3-flash",
      sessionId: "sess-zen",
    });
    expect(
      resumeCacheWriteSeed({
        at,
        storedModel: `${gemini.id}:${gemini.model}`,
        liveProvider: gemini.id,
        liveProtocol: gemini.provider,
      }),
    ).toBeUndefined();

    expect(
      resumeCacheWriteSeed({
        at,
        storedModel: "zen-messages:claude-opus-4-6",
        liveProvider: "zen",
        liveProtocol: "zen-messages",
      }),
    ).toEqual({ at, model: "zen-messages:claude-opus-4-6" });
  });
});
