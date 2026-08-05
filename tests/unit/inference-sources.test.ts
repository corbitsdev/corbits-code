import { test, expect } from "bun:test";
import {
  appendTierEntry,
  buildInferenceSourceForRef,
  buildMainSessionSources,
  buildSubagentSources,
  cycleTierMode,
  formatTierChain,
  moveTierLeg,
  normalizeTierDefinition,
  removeTierLeg,
  tierProviderRefs,
} from "../../src/config/inference-sources.js";
import type { Settings } from "../../src/config/settings.js";

import type { ProviderCatalogEntry } from "../../src/config/index.js";

const catalog: ProviderCatalogEntry[] = [
  {
    name: "openai",
    baseURL: "https://api.openai.com/v1",
    apiKey: "sk-test",
    models: ["gpt-4o", "gpt-4o-mini"],
    defaultModel: "gpt-4o",
  },
  {
    name: "local",
    baseURL: "http://localhost:11434/v1",
    keyless: true,
    models: ["llama"],
    defaultModel: "llama",
  },
  {
    name: "bifrost",
    baseURL: "http://localhost:8080/v1",
    apiKey: "sk-bf-test",
    models: ["gpt-4o"],
    defaultModel: "gpt-4o",
    bifrostVirtualKey: true,
  },
];

test("normalizeTierDefinition upgrades legacy assignment to pin chain", () => {
  const def = normalizeTierDefinition({ provider: "openai", model: "gpt-4o" });
  expect(def).toEqual({ mode: "pin", order: [{ provider: "openai", model: "gpt-4o" }] });
});

test("appendTierEntry prepends without duplicate refs", () => {
  const next = appendTierEntry(
    { mode: "prefer", order: [{ provider: "openai", model: "gpt-4o" }] },
    { provider: "local", model: "llama" },
  );
  expect(next.order.map((r) => r.provider)).toEqual(["local", "openai"]);
  const again = appendTierEntry(next, { provider: "openai", model: "gpt-4o" });
  expect(again.order).toHaveLength(2);
});

test("prefer mode appends settings providers as fallback tail", () => {
  const settings: Settings = {
    providers: {
      openai: { baseURL: "https://api.openai.com/v1", apiKey: "k", models: ["gpt-4o"] },
      local: { baseURL: "http://localhost:11434/v1", keyless: true, models: ["llama"] },
    },
    tiers: {
      fast: { mode: "prefer", order: [{ provider: "openai", model: "gpt-4o-mini" }] },
    },
  };
  const refs = tierProviderRefs("fast", settings, { fallbackChain: true });
  expect(refs.map((r) => `${r.provider}/${r.model}`)).toEqual(["openai/gpt-4o-mini", "local/llama"]);
});

test("buildInferenceSourceForRef uses bifrost provider when flag set", () => {
  const source = buildInferenceSourceForRef(
    { provider: "bifrost", model: "gpt-4o" },
    { sessionId: "s1", catalog: [...catalog] },
    undefined,
  );
  expect(source?.provider).toBe("bifrost");
  expect(source?.baseURL).toBe("http://localhost:8080/v1");
});

test("buildInferenceSourceForRef applies tier leg reasoning effort", () => {
  const settings: Settings = {
    providers: {
      openai: { baseURL: "https://api.openai.com/v1", apiKey: "k", models: ["gpt-5"] },
    },
  };
  const source = buildInferenceSourceForRef(
    { provider: "openai", model: "gpt-5", reasoningEffort: "high" },
    { sessionId: "s1", catalog: [...catalog] },
    settings,
  );
  expect(source?.defaults?.providerOptions).toEqual({ reasoning_effort: "high" });
});

test("buildMainSessionSources uses standard tier chain with active head", () => {
  const settings: Settings = {
    providers: {
      openai: { baseURL: "https://api.openai.com/v1", apiKey: "k", models: ["gpt-4o", "gpt-4o-mini"] },
      local: { baseURL: "http://localhost:11434/v1", keyless: true, models: ["llama"] },
    },
    tiers: {
      standard: {
        mode: "prefer",
        order: [{ provider: "openai", model: "gpt-4o-mini" }],
      },
    },
  };
  const bundle = buildMainSessionSources({
    settings,
    catalog: [...catalog],
    activeProvider: "openai",
    activeModel: "gpt-4o",
    sessionId: "sess",
  });
  expect(bundle.sources.length).toBeGreaterThanOrEqual(2);
  expect(bundle.defaultSource).toBe("openai");
});

test("buildSubagentSources uses full fallback chain for tier", () => {
  const settings: Settings = {
    providers: {
      openai: { baseURL: "https://api.openai.com/v1", apiKey: "k", models: ["gpt-4o"] },
      local: { baseURL: "http://localhost:11434/v1", keyless: true, models: ["llama"] },
    },
    tiers: {
      clever: { mode: "prefer", order: [{ provider: "openai", model: "gpt-4o" }] },
    },
  };
  const bundle = buildSubagentSources({
    settings,
    catalog: [...catalog],
    tier: "clever",
    head: { provider: "openai", model: "gpt-4o" },
    sessionId: "sub",
  });
  expect(bundle.sources.length).toBeGreaterThanOrEqual(2);
});

test("cycleTierMode toggles pin and prefer", () => {
  expect(cycleTierMode({ mode: "pin", order: [] }).mode).toBe("prefer");
  expect(formatTierChain({ mode: "pin", order: [{ provider: "a", model: "m" }] })).toContain("pin");
});

test("formatTierChain shows reasoning effort on legs", () => {
  const label = formatTierChain({
    mode: "pin",
    order: [{ provider: "openai", model: "gpt-5", reasoningEffort: "high" }],
  });
  expect(label).toContain("gpt-5@high");
});

test("buildInferenceSourceForRef routes OpenCode Go models by protocol", () => {
  const goCatalog: ProviderCatalogEntry[] = [
    {
      name: "opencode-go",
      baseURL: "https://opencode.ai/zen/go/v1",
      apiKey: "sk-go-test-key",
      models: ["kimi-k2.7-code", "gpt-5.6-luna", "minimax-m3"],
      defaultModel: "kimi-k2.7-code",
      opencodeGo: true,
    },
  ];
  const ctx = { sessionId: "go", catalog: goCatalog };

  const chat = buildInferenceSourceForRef(
    { provider: "opencode-go", model: "kimi-k2.7-code" },
    ctx,
    undefined,
  );
  expect(chat?.provider).toBe("openai-compatible");
  expect(chat?.baseURL).toBe("https://opencode.ai/zen/go/v1");
  expect(chat?.model).toBe("kimi-k2.7-code");

  const responses = buildInferenceSourceForRef(
    { provider: "opencode-go", model: "gpt-5.6-luna" },
    ctx,
    undefined,
  );
  expect(responses?.provider).toBe("openai-responses");
  expect(responses?.baseURL).toBe("https://opencode.ai/zen/go/v1");

  const messages = buildInferenceSourceForRef(
    { provider: "opencode-go", model: "minimax-m3" },
    ctx,
    undefined,
  );
  expect(messages?.provider).toBe("anthropic");
  expect(messages?.baseURL).toBe("https://opencode.ai/zen/go");
  expect(messages?.model).toBe("minimax-m3");
});

test("buildInferenceSourceForRef uses anthropic provider when flag set", () => {
  const anthropicCatalog: ProviderCatalogEntry[] = [
    {
      name: "anthropic",
      baseURL: "https://api.anthropic.com",
      apiKey: "sk-ant-test",
      models: ["claude-sonnet-4-5"],
      defaultModel: "claude-sonnet-4-5",
      anthropic: true,
    },
  ];
  const source = buildInferenceSourceForRef(
    { provider: "anthropic", model: "claude-sonnet-4-5" },
    { sessionId: "a", catalog: anthropicCatalog },
    undefined,
  );
  expect(source?.provider).toBe("anthropic");
  expect(source?.baseURL).toBe("https://api.anthropic.com");
});

test("removeTierLeg and moveTierLeg edit the chain", () => {
  const def = { mode: "prefer" as const, order: [{ provider: "a", model: "1" }, { provider: "b", model: "2" }] };
  const one = removeTierLeg(def, 0);
  expect(one?.order.map((r) => r.provider)).toEqual(["b"]);
  expect(removeTierLeg(one, 0)).toBeUndefined();
  expect(moveTierLeg(def, 1, -1)?.order.map((r) => r.provider)).toEqual(["b", "a"]);
});