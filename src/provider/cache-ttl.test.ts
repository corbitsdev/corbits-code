import { describe, expect, test } from "bun:test";
import { cacheTtlMsFor } from "./cache-ttl.js";

const MINUTE_MS = 60_000;

describe("cacheTtlMsFor", () => {
  test("maps providers to their documented cache TTL windows", () => {
    expect(cacheTtlMsFor("anthropic/claude-opus-4-6")).toBe(5 * MINUTE_MS);
    expect(cacheTtlMsFor("openai-responses/gpt-5.6")).toBe(10 * MINUTE_MS);
    expect(cacheTtlMsFor("codex-responses/gpt-5.6")).toBe(10 * MINUTE_MS);
    expect(cacheTtlMsFor("openai-compatible/custom")).toBe(10 * MINUTE_MS);
    expect(cacheTtlMsFor("xai/thegreataxios")).toBe(10 * MINUTE_MS);
    expect(cacheTtlMsFor("gemini/gemini-3-pro")).toBe(15 * MINUTE_MS);
    expect(cacheTtlMsFor("deepseek/deepseek-chat")).toBe(60 * MINUTE_MS);
  });

  test("covers Anthropic-protocol adapters with the 5-minute window", () => {
    expect(cacheTtlMsFor("zen-messages/claude-opus-4-6")).toBe(5 * MINUTE_MS);
    expect(cacheTtlMsFor("opencode-go-messages/claude-opus-4-6")).toBe(
      5 * MINUTE_MS,
    );
  });

  test("disables idle recompress for local inference and missing model ids", () => {
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

  test("maps bare LastCycleSource ids through provider and family", () => {
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
    ).toBe(10 * MINUTE_MS);
  });

  test("falls back to model family for unrecognized provider prefixes", () => {
    expect(cacheTtlMsFor("proxy-acme/grok-4")).toBe(10 * MINUTE_MS);
    expect(cacheTtlMsFor("proxy-acme/gemini-3-pro")).toBe(15 * MINUTE_MS);
    expect(cacheTtlMsFor("proxy-acme/ollama-qwen")).toBeUndefined();
    // An exact provider-segment match wins over the model family: an
    // openai-compatible account fronting Claude keeps the generic window.
    expect(cacheTtlMsFor("openai-compatible/claude-opus-4-6")).toBe(
      10 * MINUTE_MS,
    );
  });

  test("assumes OpenAI-style economics for unrecognized providers", () => {
    expect(cacheTtlMsFor("bifrost/some-model")).toBe(10 * MINUTE_MS);
    expect(cacheTtlMsFor("totally-new-provider/model-x")).toBe(10 * MINUTE_MS);
    // A truly unknown id (no provider segment, no family substring) still
    // gets the 10-minute default — not the local-inference disable.
    expect(cacheTtlMsFor("unknown-id")).toBe(10 * MINUTE_MS);
  });
});
