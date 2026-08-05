import { describe, expect, test } from "bun:test";
import { buildProviderEntry } from "../../src/config/providers.js";
import type { ProviderCatalogEntry } from "../../src/config/index.js";

const goEntry = (): ProviderCatalogEntry => ({
  name: "opencode-go",
  baseURL: "https://opencode.ai/zen/go/v1",
  apiKey: "sk-go-longenough",
  models: ["kimi-k2.7-code", "minimax-m3"],
  defaultModel: "kimi-k2.7-code",
  opencodeGo: true,
});

const anthropicEntry = (): ProviderCatalogEntry => ({
  name: "anthropic",
  baseURL: "https://api.anthropic.com",
  apiKey: "sk-ant-longenough",
  models: ["claude-sonnet-4"],
  defaultModel: "claude-sonnet-4",
  anthropic: true,
});

describe("buildProviderEntry protocol flag preservation", () => {
  test("preserves opencodeGo when editing without resubmitting the flag", () => {
    const result = buildProviderEntry(
      {
        originalName: "opencode-go",
        name: "opencode-go",
        baseURL: "https://opencode.ai/zen/go/v1",
        models: ["kimi-k2.7-code", "minimax-m3"],
        defaultModel: "kimi-k2.7-code",
      },
      [goEntry()],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.opencodeGo).toBe(true);
  });

  test("preserves anthropic when editing without resubmitting the flag", () => {
    const result = buildProviderEntry(
      {
        originalName: "anthropic",
        name: "anthropic",
        baseURL: "https://api.anthropic.com",
        models: ["claude-sonnet-4"],
      },
      [anthropicEntry()],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.anthropic).toBe(true);
  });

  test("does not invent protocol flags for plain provider edits", () => {
    const result = buildProviderEntry(
      {
        originalName: "openai",
        name: "openai",
        baseURL: "https://api.openai.com/v1",
        models: ["gpt-4o"],
      },
      [
        {
          name: "openai",
          baseURL: "https://api.openai.com/v1",
          apiKey: "sk-oai",
          models: ["gpt-4o"],
        },
      ],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.anthropic).toBeUndefined();
    expect(result.entry.opencodeGo).toBeUndefined();
  });

  test("honors explicit connect flags on create", () => {
    const result = buildProviderEntry(
      {
        name: "opencode-go",
        baseURL: "https://opencode.ai/zen/go/v1",
        apiKey: "sk-go-longenough",
        models: ["kimi-k2.7-code"],
        opencodeGo: true,
      },
      [],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.opencodeGo).toBe(true);
  });

  test("empty-key re-Connect preserves existing apiKey", () => {
    // Re-Connect / edit without re-entering the key must keep the catalog secret.
    const result = buildProviderEntry(
      {
        originalName: "opencode-go",
        name: "opencode-go",
        baseURL: "https://opencode.ai/zen/go/v1",
        models: ["kimi-k2.7-code", "minimax-m3"],
        defaultModel: "kimi-k2.7-code",
        opencodeGo: true,
      },
      [goEntry()],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.apiKey).toBe("sk-go-longenough");
    expect(result.entry.opencodeGo).toBe(true);
  });
});
