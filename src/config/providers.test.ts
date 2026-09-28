import { describe, expect, test } from "bun:test";

import { OPENCODE_GO_BASE_URL } from "../../packages/opencode-go/src/index.js";
import type { ProviderCatalogEntry } from "./index.js";
import { buildProviderEntry, resolveDefaultModel } from "./providers.js";

function expectBuiltEntry(
  submission: Parameters<typeof buildProviderEntry>[0],
  catalog: readonly ProviderCatalogEntry[] = [],
) {
  const result = buildProviderEntry(submission, catalog);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.entry;
}

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

  test("does not rewrite baseURL for non-Go providers", () => {
    const entry = expectBuiltEntry({
      name: "zen",
      baseURL: "https://opencode.ai/zen/v1",
      apiKey: "sk-zen-key",
      models: ["claude-sonnet-4-5"],
    });
    expect(entry.baseURL).toBe("https://opencode.ai/zen/v1");
    expect(entry.opencodeGo).toBeUndefined();
  });

  test("pins Go baseURL when name is opencode-go even without opencodeGo flag", () => {
    const entry = expectBuiltEntry({
      name: "opencode-go",
      baseURL: "https://opencode.ai/zen/v1",
      apiKey: "sk-go-key-long-enough",
      models: ["kimi-k2.7-code"],
    });
    expect(entry.baseURL).toBe(OPENCODE_GO_BASE_URL);
    expect(entry.opencodeGo).toBe(true);
  });

  test("pins Go baseURL and flag for custom name with Go URL", () => {
    const entry = expectBuiltEntry({
      name: "go/personal",
      baseURL: "https://opencode.ai/zen/go/v1",
      apiKey: "sk-go-key-long-enough",
      models: ["kimi-k2.7-code"],
    });
    expect(entry.baseURL).toBe(OPENCODE_GO_BASE_URL);
    expect(entry.opencodeGo).toBe(true);
  });

  test("does not treat bare Zen URL as Go for custom names", () => {
    const entry = expectBuiltEntry({
      name: "go/personal",
      baseURL: "https://opencode.ai/zen/v1",
      apiKey: "sk-zen-key",
      models: ["claude-sonnet-4-5"],
    });
    expect(entry.baseURL).toBe("https://opencode.ai/zen/v1");
    expect(entry.opencodeGo).toBeUndefined();
  });

  test("demotes sticky opencodeGo when edit submits bare Zen URL for a custom name", () => {
    // Healed row: custom name, flag + canonical Go base. User restores PAYG Zen
    // without delete/recreate — URL wins demotion.
    const catalog: ProviderCatalogEntry[] = [
      {
        name: "go/personal",
        baseURL: OPENCODE_GO_BASE_URL,
        apiKey: "sk-go-existing",
        models: ["kimi-k2.7-code"],
        opencodeGo: true,
      },
    ];
    const result = buildProviderEntry(
      {
        name: "go/personal",
        originalName: "go/personal",
        baseURL: "https://opencode.ai/zen/v1",
        models: ["claude-sonnet-4-5"],
        // Form draft may still re-assert the flag; URL demotes anyway.
        opencodeGo: true,
      },
      catalog,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.baseURL).toBe("https://opencode.ai/zen/v1");
    expect(result.entry.opencodeGo).toBeUndefined();
  });

  test("known Go id still pins when form submits bare Zen (name identity)", () => {
    // First-class opencode-go row cannot demote by URL alone — rename or delete.
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
});

describe("resolveDefaultModel", () => {
  test("prefers a non-empty defaultModel, falls back to models[0], and tolerates empty entries", () => {
    expect(
      resolveDefaultModel({
        defaultModel: "gpt-4o",
        models: ["gpt-4o", "gpt-4o-mini"],
      }),
    ).toBe("gpt-4o");
    expect(resolveDefaultModel({ models: ["gpt-4o", "gpt-4o-mini"] })).toBe(
      "gpt-4o",
    );
    expect(resolveDefaultModel({ defaultModel: "", models: ["gpt-4o"] })).toBe(
      "gpt-4o",
    );
    expect(resolveDefaultModel(undefined)).toBeUndefined();
    expect(resolveDefaultModel({ models: [] })).toBeUndefined();
  });
});

describe("buildProviderEntry protocol flag preservation", () => {
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
