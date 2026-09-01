import { test, expect } from "bun:test";
import {
  buildInferenceSourceForRef,
  buildMainSessionSources,
  buildSubagentSources,
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

test("buildInferenceSourceForRef uses bifrost provider when flag set", () => {
  const source = buildInferenceSourceForRef(
    { provider: "bifrost", model: "gpt-4o" },
    { sessionId: "s1", catalog: [...catalog] },
    undefined,
  );
  expect(source?.provider).toBe("bifrost");
  expect(source?.baseURL).toBe("http://localhost:8080/v1");
});

test("buildInferenceSourceForRef applies leg reasoning effort", () => {
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

test("leftover xhigh on gpt-5 inference source sends medium, not xhigh", () => {
  const settings: Settings = {
    providers: {
      openai: { baseURL: "https://api.openai.com/v1", apiKey: "k", models: ["gpt-5"] },
    },
  };
  const source = buildInferenceSourceForRef(
    { provider: "openai", model: "gpt-5", reasoningEffort: "xhigh" },
    { sessionId: "s1", catalog: [...catalog] },
    settings,
  );
  expect(source?.defaults?.providerOptions).toEqual({ reasoning_effort: "medium" });
});

test("unset still omits reasoning_effort", () => {
  const settings: Settings = {
    providers: {
      openai: { baseURL: "https://api.openai.com/v1", apiKey: "k", models: ["gpt-5"] },
    },
  };
  const source = buildInferenceSourceForRef(
    { provider: "openai", model: "gpt-5" },
    { sessionId: "s1", catalog: [...catalog] },
    settings,
  );
  expect(source?.defaults?.providerOptions).not.toHaveProperty("reasoning_effort");
});

test("buildInferenceSourceForRef forwards reasoning effort on xAI sources", () => {
  const xaiCatalog: ProviderCatalogEntry[] = [
    {
      name: "xai/work",
      baseURL: "https://api.x.ai/v1",
      apiKey: "tok",
      models: ["grok-4.6"],
      defaultModel: "grok-4.6",
      xaiProfile: "work",
    },
  ];
  const withLeg = buildInferenceSourceForRef(
    { provider: "xai/work", model: "grok-4.6", reasoningEffort: "low" },
    { sessionId: "s1", catalog: xaiCatalog },
    undefined,
  );
  expect(withLeg?.provider).toBe("grok-responses");
  expect(withLeg?.defaults?.providerOptions).toMatchObject({ reasoning_effort: "low" });

  const withCtx = buildInferenceSourceForRef(
    { provider: "xai/work", model: "grok-4.6" },
    { sessionId: "s1", catalog: xaiCatalog, reasoningEffort: "medium" },
    undefined,
  );
  expect(withCtx?.defaults?.providerOptions).toMatchObject({ reasoning_effort: "medium" });

  const unset = buildInferenceSourceForRef(
    { provider: "xai/work", model: "grok-4.6" },
    { sessionId: "s1", catalog: xaiCatalog },
    undefined,
  );
  expect(unset?.defaults?.providerOptions).not.toHaveProperty("reasoning_effort");
});

test("buildMainSessionSources backs the active head with other configured providers", () => {
  const settings: Settings = {
    providers: {
      openai: {
        baseURL: "https://api.openai.com/v1",
        apiKey: "k",
        models: ["gpt-4o", "gpt-4o-mini"],
      },
      local: { baseURL: "http://localhost:11434/v1", keyless: true, models: ["llama"] },
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

test("ollama backup with leftover extra path does not throw when OpenAI is active", () => {
  const leftoverURL = "http://localhost:11434/api/tags";
  const settings: Settings = {
    providers: {
      openai: {
        baseURL: "https://api.openai.com/v1",
        apiKey: "k",
        models: ["gpt-4o"],
      },
      ollama: { baseURL: leftoverURL, keyless: true, models: ["llama3"] },
    },
  };
  const mixedCatalog: ProviderCatalogEntry[] = [
    {
      name: "openai",
      baseURL: "https://api.openai.com/v1",
      apiKey: "k",
      models: ["gpt-4o"],
      defaultModel: "gpt-4o",
    },
    {
      name: "ollama",
      baseURL: leftoverURL,
      keyless: true,
      models: ["llama3"],
      defaultModel: "llama3",
    },
  ];
  const bundle = buildMainSessionSources({
    settings,
    catalog: mixedCatalog,
    activeProvider: "openai",
    activeModel: "gpt-4o",
    sessionId: "sess",
  });
  expect(bundle.defaultSource).toBe("openai");
  expect(bundle.sources.map((s) => s.id)).toEqual(["openai"]);
});

test("active ollama with leftover extra path still fails that provider", () => {
  const leftoverURL = "http://localhost:11434/api/tags";
  const settings: Settings = {
    providers: {
      ollama: { baseURL: leftoverURL, keyless: true, models: ["llama3"] },
      openai: {
        baseURL: "https://api.openai.com/v1",
        apiKey: "k",
        models: ["gpt-4o"],
      },
    },
  };
  const mixedCatalog: ProviderCatalogEntry[] = [
    {
      name: "ollama",
      baseURL: leftoverURL,
      keyless: true,
      models: ["llama3"],
      defaultModel: "llama3",
    },
    {
      name: "openai",
      baseURL: "https://api.openai.com/v1",
      apiKey: "k",
      models: ["gpt-4o"],
      defaultModel: "gpt-4o",
    },
  ];
  expect(() =>
    buildMainSessionSources({
      settings,
      catalog: mixedCatalog,
      activeProvider: "ollama",
      activeModel: "llama3",
      sessionId: "sess",
    }),
  ).toThrow('No inference source for provider "ollama"');
});

test("legacy ollama /v1 backup does not throw when OpenAI is active", () => {
  const settings: Settings = {
    providers: {
      openai: {
        baseURL: "https://api.openai.com/v1",
        apiKey: "k",
        models: ["gpt-4o"],
      },
      ollama: { baseURL: "http://localhost:11434/v1", keyless: true, models: ["llama3"] },
    },
  };
  const mixedCatalog: ProviderCatalogEntry[] = [
    {
      name: "openai",
      baseURL: "https://api.openai.com/v1",
      apiKey: "k",
      models: ["gpt-4o"],
      defaultModel: "gpt-4o",
    },
    {
      name: "ollama",
      baseURL: "http://localhost:11434/v1",
      keyless: true,
      models: ["llama3"],
      defaultModel: "llama3",
    },
  ];
  const bundle = buildMainSessionSources({
    settings,
    catalog: mixedCatalog,
    activeProvider: "openai",
    activeModel: "gpt-4o",
    sessionId: "sess",
  });
  expect(bundle.defaultSource).toBe("openai");
  expect(bundle.sources.find((s) => s.id === "ollama")?.baseURL).toBe("http://localhost:11434/v1");
});

test("buildSubagentSources backs the head with other configured providers", () => {
  const settings: Settings = {
    providers: {
      openai: { baseURL: "https://api.openai.com/v1", apiKey: "k", models: ["gpt-4o"] },
      local: { baseURL: "http://localhost:11434/v1", keyless: true, models: ["llama"] },
    },
  };
  const bundle = buildSubagentSources({
    settings,
    catalog: [...catalog],
    head: { provider: "openai", model: "gpt-4o" },
    sessionId: "sub",
  });
  expect(bundle.sources.length).toBeGreaterThanOrEqual(2);
  expect(bundle.defaultSource).toBe("openai");
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
