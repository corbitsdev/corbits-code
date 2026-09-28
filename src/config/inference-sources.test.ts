import { describe, test, expect, afterEach } from "bun:test";
import type { ConversationTurn, InferenceOptions } from "@intx/types/runtime";
import { SOURCE_MAX_TOKENS, type ProviderCatalogEntry } from "./index.js";
import {
  buildInferenceSourceForRef,
  buildMainSessionSources,
  buildSubagentSources,
  type BuildSourceContext,
} from "./inference-sources.js";
import type { Settings } from "./settings.js";
import {
  buildProviderContextWindowOverrides,
  contextWindowFor,
  setProviderContextWindowOverrides,
} from "../provider/context-window.js";
import { createOpenAICompatibleAdapter } from "../provider/openai-compatible-adapter.js";
import { createInferenceDependencies } from "../provider/inference-dependencies.js";
import {
  clearSourceCredentials,
  readSourceCredentialRecord,
} from "./source-credentials.js";
import { OPENAI_RESPONSES_PROVIDER } from "../provider/openai-responses.js";
import { CODEX_ACCOUNT_ID_OPTION } from "../provider/codex-responses.js";
import { GROK_USER_ID_OPTION } from "../provider/grok-responses.js";
import { ZEN_MESSAGES_PROVIDER } from "../provider/anthropic-session-adapter.js";
import { firstClassProviderById } from "../../packages/first-class-providers/src/index.js";
import {
  ZEN_DEFAULT_BASE_URL,
  ZEN_PROVIDER_ID,
} from "../../packages/zen/src/index.js";

const WINDOW = 400_000;

// Routing must stay off the network: any fetch here is a regression.
const originalFetch = globalThis.fetch;

function zenCatalog(): ProviderCatalogEntry[] {
  return [
    {
      name: ZEN_PROVIDER_ID,
      baseURL: ZEN_DEFAULT_BASE_URL,
      apiKey: "zen-key",
      models: [
        "muse-spark-1.3-contributor-free",
        "claude-sonnet-4-5",
        "gemini-3-flash",
        "some-future-model",
      ],
    },
  ];
}

function zenSource(model: string) {
  return buildInferenceSourceForRef(
    { provider: ZEN_PROVIDER_ID, model },
    { sessionId: "sess-zen", catalog: zenCatalog() },
    undefined,
  );
}

function catalog(): ProviderCatalogEntry[] {
  return [
    {
      name: "fp",
      baseURL: "https://fp.example/v1",
      apiKey: "fp-key",
      models: ["fp-large"],
    },
  ];
}

function ctx(): BuildSourceContext {
  return { sessionId: "sess-1", catalog: catalog() };
}

function settingsWithWindow(): Settings {
  return {
    providers: {
      fp: {
        baseURL: "https://fp.example/v1",
        apiKey: "fp-key",
        models: ["fp-large"],
        contextWindow: WINDOW,
      },
    },
  };
}

afterEach(() => {
  setProviderContextWindowOverrides(undefined);
  globalThis.fetch = originalFetch;
  clearSourceCredentials();
});

describe("source credential provenance", () => {
  test("OAuth provenance comes from catalog profile markers", () => {
    const source = buildInferenceSourceForRef(
      { provider: "codex/work", model: "gpt-5" },
      {
        sessionId: "sess-oauth",
        catalog: [
          {
            name: "codex/work",
            baseURL: "https://chatgpt.com/backend-api/codex",
            apiKey: "oauth-token",
            models: ["gpt-5"],
            codexProfile: "work",
            codexAccountId: "account-1",
          },
        ],
      },
      undefined,
    );

    if (source === null) throw new Error("expected Codex source");
    expect(source.defaults?.providerOptions).not.toHaveProperty(
      CODEX_ACCOUNT_ID_OPTION,
    );
    expect(readSourceCredentialRecord(source.credentialId).provenance).toEqual({
      kind: "oauth",
      provider: "codex",
      profile: "work",
    });
  });

  test("xAI identity lives only in mutable credential material", () => {
    const source = buildInferenceSourceForRef(
      { provider: "xai/work", model: "grok-code-fast-1" },
      {
        sessionId: "sess-oauth",
        catalog: [
          {
            name: "xai/work",
            baseURL: "https://api.x.ai/v1",
            apiKey: "header.eyJzdWIiOiJ1c2VyLWEifQ.signature",
            models: ["grok-code-fast-1"],
            xaiProfile: "work",
          },
        ],
      },
      undefined,
    );

    if (source === null) throw new Error("expected xAI source");
    expect(source.defaults?.providerOptions).not.toHaveProperty(
      GROK_USER_ID_OPTION,
    );
    expect(
      readSourceCredentialRecord(source.credentialId).material.headers,
    ).toEqual({ "x-grok-user-id": "user-a" });
  });

  test("namespaced API-key rows are not inferred as OAuth", () => {
    const source = buildInferenceSourceForRef(
      { provider: "codex/shadow", model: "relay-model" },
      {
        sessionId: "sess-key",
        catalog: [
          {
            name: "codex/shadow",
            baseURL: "https://relay.example/v1",
            apiKey: "explicit-key",
            models: ["relay-model"],
          },
        ],
      },
      undefined,
    );

    if (source === null) throw new Error("expected API-key source");
    expect(source.provider).toBe("openai-compatible");
    expect(readSourceCredentialRecord(source.credentialId).provenance).toEqual({
      kind: "api-key",
    });
  });
});

describe("contextWindow / maxTokens split (CL-7784)", () => {
  test("contextWindow 400000 does not reach the wire as max_tokens 400000", () => {
    const source = buildInferenceSourceForRef(
      { provider: "fp", model: "fp-large" },
      ctx(),
      settingsWithWindow(),
    );
    const adapter = createOpenAICompatibleAdapter(
      source as unknown as Parameters<typeof createOpenAICompatibleAdapter>[0],
    );
    const messages = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ] as unknown as ConversationTurn[];
    const built = adapter.buildRequest(messages, "fp-large", {
      maxTokens: source?.defaults?.maxTokens,
    } as InferenceOptions);
    const body = JSON.parse(built.body) as Record<string, unknown>;
    expect(body["max_tokens"]).toBe(SOURCE_MAX_TOKENS);
    expect(body["max_tokens"]).not.toBe(WINDOW);
  });

  test("setting contextWindow still changes contextWindowFor", () => {
    const settings = settingsWithWindow();
    setProviderContextWindowOverrides(
      buildProviderContextWindowOverrides(settings.providers, "fp", "fp-large"),
    );
    expect(contextWindowFor("fp:fp-large")).toBe(WINDOW);
  });
});

describe("OpenAI reasoning max_completion_tokens quirk (CL-7785)", () => {
  const openaiApi = firstClassProviderById("openai")?.paths?.find(
    (p) => p.id === "api",
  );
  const presetModels = [...(openaiApi?.models ?? [])];
  const presetBaseURL = openaiApi?.baseURL ?? "";
  // A relay serving the same model names through the same adapter but taking
  // max_tokens (per the vendor adapter comment) — the quirk must not follow
  // the bare model name there.
  const RELAY_BASE_URL = "https://opencode.ai/zen/v1";

  function wireBody(model: string, baseURL: string): Record<string, unknown> {
    const entryCatalog: ProviderCatalogEntry[] = [
      { name: "openai", baseURL, apiKey: "test-key", models: [model] },
    ];
    const source = buildInferenceSourceForRef(
      { provider: "openai", model },
      { sessionId: "sess-1", catalog: entryCatalog },
      undefined,
    );
    // Mirror the harness: it resolves the adapter with source.quirks.
    const adapter = createOpenAICompatibleAdapter(
      source as unknown as Parameters<typeof createOpenAICompatibleAdapter>[0],
      source?.quirks,
    );
    const messages = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ] as unknown as ConversationTurn[];
    const built = adapter.buildRequest(messages, model, {
      maxTokens: source?.defaults?.maxTokens,
    } as InferenceOptions);
    return JSON.parse(built.body) as Record<string, unknown>;
  }

  test("shipped preset declares an explicit per-model requirement", () => {
    expect(presetModels.length).toBeGreaterThan(0);
    expect(openaiApi?.maxCompletionTokensModels?.length).toBeGreaterThan(0);
    for (const model of openaiApi?.maxCompletionTokensModels ?? []) {
      expect(presetModels).toContain(model);
    }
  });

  test("reasoning preset models emit max_completion_tokens, never max_tokens", () => {
    for (const model of openaiApi?.maxCompletionTokensModels ?? []) {
      const body = wireBody(model, presetBaseURL);
      expect(body["max_completion_tokens"]).toBe(SOURCE_MAX_TOKENS);
      expect("max_tokens" in body).toBe(false);
    }
  });

  test("non-reasoning preset models keep max_tokens", () => {
    const declared = new Set(openaiApi?.maxCompletionTokensModels ?? []);
    const rest = presetModels.filter((m) => !declared.has(m));
    expect(rest.length).toBeGreaterThan(0);
    for (const model of rest) {
      const body = wireBody(model, presetBaseURL);
      expect(body["max_tokens"]).toBe(SOURCE_MAX_TOKENS);
      expect("max_completion_tokens" in body).toBe(false);
    }
  });

  test("relay endpoint keeps max_tokens for every preset model", () => {
    for (const model of presetModels) {
      const body = wireBody(model, RELAY_BASE_URL);
      expect(body["max_tokens"]).toBe(SOURCE_MAX_TOKENS);
      expect("max_completion_tokens" in body).toBe(false);
    }
  });
});

describe("Zen protocol routing (CL-7811)", () => {
  test("routes without touching the network", () => {
    globalThis.fetch = (async () => {
      throw new Error("routing must not fetch");
    }) as unknown as typeof fetch;
    const source = zenSource("muse-spark-1.3-contributor-free");
    expect(source?.provider).toBe(OPENAI_RESPONSES_PROVIDER);
  });

  test("Muse Spark contributor-free build rides the Responses protocol", () => {
    const source = zenSource("muse-spark-1.3-contributor-free");
    expect(source?.provider).toBe(OPENAI_RESPONSES_PROVIDER);
    expect(source?.baseURL).toBe(ZEN_DEFAULT_BASE_URL);
    expect(source?.model).toBe("muse-spark-1.3-contributor-free");
  });

  test("Claude models ride the Messages protocol on the Zen root", () => {
    const source = zenSource("claude-sonnet-4-5");
    expect(source?.provider).toBe(ZEN_MESSAGES_PROVIDER);
    expect(source?.baseURL).toBe("https://opencode.ai/zen");
  });

  test("Gemini models stay on chat completions", () => {
    const source = zenSource("gemini-3-flash");
    expect(source?.provider).toBe("openai-compatible");
    expect(source?.baseURL).toBe(ZEN_DEFAULT_BASE_URL);
  });

  test("unknown ids default to chat completions, never name-prefix inference", () => {
    const source = zenSource("some-future-model");
    expect(source?.provider).toBe("openai-compatible");
    expect(source?.baseURL).toBe(ZEN_DEFAULT_BASE_URL);
  });

  test("chat-completions Zen sources resolve to a registered adapter", async () => {
    const deps = await createInferenceDependencies();
    for (const model of ["gemini-3-flash", "some-future-model"]) {
      const source = zenSource(model);
      expect(source?.provider).toBe("openai-compatible");
      expect(source).toBeDefined();
      if (source === undefined || source === null) continue;
      expect(() =>
        deps.adapters.resolve(
          {
            sourceId: source.id,
            provider: source.provider,
            model: source.model,
          },
          source.quirks,
        ),
      ).not.toThrow();
    }
  });
});

describe("protocol flag routing", () => {
  const flagCatalog: ProviderCatalogEntry[] = [
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

  test("uses bifrost provider when flag set", () => {
    const source = buildInferenceSourceForRef(
      { provider: "bifrost", model: "gpt-4o" },
      { sessionId: "s1", catalog: [...flagCatalog] },
      undefined,
    );
    expect(source?.provider).toBe("bifrost");
    expect(source?.baseURL).toBe("http://localhost:8080/v1");
  });

  test("uses anthropic provider when flag set", () => {
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

  test("routes OpenCode Go models by protocol", () => {
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
    expect(chat?.provider).toBe("opencode-go");
    expect(chat?.quirks).toBeUndefined();
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
    expect(messages?.provider).toBe("opencode-go-messages");
    expect(messages?.baseURL).toBe("https://opencode.ai/zen/go");
    expect(messages?.model).toBe("minimax-m3");
  });
});

describe("reasoning effort on the wire", () => {
  const effortSettings: Settings = {
    providers: {
      openai: {
        baseURL: "https://api.openai.com/v1",
        apiKey: "k",
        models: ["gpt-5"],
      },
    },
  };
  const effortCatalog: ProviderCatalogEntry[] = [
    {
      name: "openai",
      baseURL: "https://api.openai.com/v1",
      apiKey: "sk-test",
      models: ["gpt-4o", "gpt-4o-mini"],
      defaultModel: "gpt-4o",
    },
  ];

  test("applies leg reasoning effort", () => {
    const source = buildInferenceSourceForRef(
      { provider: "openai", model: "gpt-5", reasoningEffort: "high" },
      { sessionId: "s1", catalog: [...effortCatalog] },
      effortSettings,
    );
    expect(source?.defaults?.providerOptions).toEqual({
      reasoning_effort: "high",
    });
  });

  test("leftover xhigh on gpt-5 inference source sends medium, not xhigh", () => {
    const source = buildInferenceSourceForRef(
      { provider: "openai", model: "gpt-5", reasoningEffort: "xhigh" },
      { sessionId: "s1", catalog: [...effortCatalog] },
      effortSettings,
    );
    expect(source?.defaults?.providerOptions).toEqual({
      reasoning_effort: "medium",
    });
  });

  test("unset still omits reasoning_effort", () => {
    const source = buildInferenceSourceForRef(
      { provider: "openai", model: "gpt-5" },
      { sessionId: "s1", catalog: [...effortCatalog] },
      effortSettings,
    );
    expect(source?.defaults?.providerOptions).not.toHaveProperty(
      "reasoning_effort",
    );
  });

  test("forwards reasoning effort on xAI sources", () => {
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
    expect(withLeg?.defaults?.providerOptions).toMatchObject({
      reasoning_effort: "low",
    });

    const withCtx = buildInferenceSourceForRef(
      { provider: "xai/work", model: "grok-4.6" },
      { sessionId: "s1", catalog: xaiCatalog, reasoningEffort: "medium" },
      undefined,
    );
    expect(withCtx?.defaults?.providerOptions).toMatchObject({
      reasoning_effort: "medium",
    });

    const unset = buildInferenceSourceForRef(
      { provider: "xai/work", model: "grok-4.6" },
      { sessionId: "s1", catalog: xaiCatalog },
      undefined,
    );
    expect(unset?.defaults?.providerOptions).not.toHaveProperty(
      "reasoning_effort",
    );
  });
});

describe("session source bundles", () => {
  const bundleCatalog: ProviderCatalogEntry[] = [
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
  ];
  const bundleSettings: Settings = {
    providers: {
      openai: {
        baseURL: "https://api.openai.com/v1",
        apiKey: "k",
        models: ["gpt-4o", "gpt-4o-mini"],
      },
      local: {
        baseURL: "http://localhost:11434/v1",
        keyless: true,
        models: ["llama"],
      },
    },
  };

  test("buildMainSessionSources includes only the selected provider and model", () => {
    const bundle = buildMainSessionSources({
      settings: bundleSettings,
      catalog: [...bundleCatalog],
      activeProvider: "openai",
      activeModel: "gpt-4o",
      sessionId: "sess",
    });
    expect(bundle.sources).toHaveLength(1);
    expect(bundle.sources[0]).toMatchObject({ id: "openai", model: "gpt-4o" });
    expect(bundle.defaultSource).toBe("openai");
  });

  test("buildSubagentSources includes only the selected provider and model", () => {
    const bundle = buildSubagentSources({
      settings: bundleSettings,
      catalog: [...bundleCatalog],
      head: { provider: "openai", model: "gpt-4o" },
      sessionId: "sub",
    });
    expect(bundle.sources).toHaveLength(1);
    expect(bundle.sources[0]).toMatchObject({ id: "openai", model: "gpt-4o" });
    expect(bundle.defaultSource).toBe("openai");
  });
});
