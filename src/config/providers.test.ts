import { describe, expect, test } from "bun:test";

import { OPENCODE_GO_BASE_URL } from "../../packages/opencode-go/src/index.js";
import type { ProviderCatalogEntry } from "./index.js";
import { buildProviderEntry } from "./providers.js";

const baseCatalog: ProviderCatalogEntry[] = [
  {
    name: "bf",
    baseURL: "http://localhost:8080/v1",
    apiKey: "sk-bf-existing",
    models: ["m1"],
    bifrostVirtualKey: true,
  },
  {
    name: "openai",
    baseURL: "https://api.openai.com/v1",
    apiKey: "sk-openai",
    models: ["gpt-4o"],
  },
];

describe("buildProviderEntry bifrostVirtualKey preserve-on-edit", () => {
  test("keeps existing bifrostVirtualKey when submission omits the flag", () => {
    const result = buildProviderEntry(
      {
        name: "bf",
        originalName: "bf",
        baseURL: "http://localhost:8080/v1",
        models: ["m1", "m2"],
      },
      baseCatalog,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.bifrostVirtualKey).toBe(true);
  });

  test("omits bifrostVirtualKey when existing entry has no flag", () => {
    const result = buildProviderEntry(
      {
        name: "openai",
        originalName: "openai",
        baseURL: "https://api.openai.com/v1",
        models: ["gpt-4o-mini"],
      },
      baseCatalog,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.bifrostVirtualKey).toBeUndefined();
  });
});

describe("buildProviderEntry OpenCode Go baseURL pin", () => {
  test("forces OPENCODE_GO_BASE_URL when opencodeGo is true even if submission is bare zen", () => {
    const result = buildProviderEntry(
      {
        name: "opencode-go",
        baseURL: "https://opencode.ai/zen/v1",
        apiKey: "sk-go-key-long-enough",
        models: ["kimi-k2.7-code"],
        defaultModel: "kimi-k2.7-code",
        opencodeGo: true,
      },
      [],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.baseURL).toBe(OPENCODE_GO_BASE_URL);
    expect(result.entry.opencodeGo).toBe(true);
    expect(result.entry.baseURL).not.toBe("https://opencode.ai/zen/v1");
  });

  test("pins Go baseURL on edit when existing has opencodeGo and form submits zen URL", () => {
    const catalog: ProviderCatalogEntry[] = [
      {
        name: "opencode-go",
        baseURL: OPENCODE_GO_BASE_URL,
        apiKey: "sk-go-existing",
        models: ["kimi-k2.7-code"],
        opencodeGo: true,
      },
    ];
    const result = buildProviderEntry(
      {
        name: "opencode-go",
        originalName: "opencode-go",
        baseURL: "https://opencode.ai/zen/v1",
        models: ["kimi-k2.7-code"],
      },
      catalog,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.baseURL).toBe(OPENCODE_GO_BASE_URL);
    expect(result.entry.opencodeGo).toBe(true);
  });

  test("does not rewrite baseURL for non-Go providers", () => {
    const result = buildProviderEntry(
      {
        name: "zen",
        baseURL: "https://opencode.ai/zen/v1",
        apiKey: "sk-zen-key",
        models: ["claude-sonnet-4-5"],
      },
      [],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.baseURL).toBe("https://opencode.ai/zen/v1");
    expect(result.entry.opencodeGo).toBeUndefined();
  });

  test("pins Go baseURL when name is opencode-go even without opencodeGo flag", () => {
    const result = buildProviderEntry(
      {
        name: "opencode-go",
        baseURL: "https://opencode.ai/zen/v1",
        apiKey: "sk-go-key-long-enough",
        models: ["kimi-k2.7-code"],
      },
      [],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.baseURL).toBe(OPENCODE_GO_BASE_URL);
    expect(result.entry.opencodeGo).toBe(true);
  });

  test("pins Go baseURL when name is OpenCode Go display label", () => {
    const result = buildProviderEntry(
      {
        name: "OpenCode Go",
        baseURL: "https://opencode.ai/zen/v1",
        apiKey: "sk-go-key-long-enough",
        models: ["kimi-k2.7-code"],
      },
      [],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.baseURL).toBe(OPENCODE_GO_BASE_URL);
    expect(result.entry.opencodeGo).toBe(true);
  });

  test("pins Go baseURL and flag for custom name with Go URL", () => {
    const result = buildProviderEntry(
      {
        name: "go/personal",
        baseURL: "https://opencode.ai/zen/go/v1",
        apiKey: "sk-go-key-long-enough",
        models: ["kimi-k2.7-code"],
      },
      [],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.baseURL).toBe(OPENCODE_GO_BASE_URL);
    expect(result.entry.opencodeGo).toBe(true);
  });

  test("does not treat bare Zen URL as Go for custom names", () => {
    const result = buildProviderEntry(
      {
        name: "go/personal",
        baseURL: "https://opencode.ai/zen/v1",
        apiKey: "sk-zen-key",
        models: ["claude-sonnet-4-5"],
      },
      [],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.baseURL).toBe("https://opencode.ai/zen/v1");
    expect(result.entry.opencodeGo).toBeUndefined();
  });
});
