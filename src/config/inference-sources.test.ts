import { describe, test, expect, afterEach } from "bun:test";
import type { ConversationTurn, InferenceOptions } from "@intx/types/runtime";
import { SOURCE_MAX_TOKENS, type ProviderCatalogEntry } from "./index.js";
import {
  buildInferenceSourceForRef,
  type BuildSourceContext,
} from "./inference-sources.js";
import type { Settings } from "./settings.js";
import {
  buildProviderContextWindowOverrides,
  contextWindowFor,
  setProviderContextWindowOverrides,
} from "../provider/context-window.js";
import { createOpenAICompatibleAdapter } from "../provider/openai-compatible-adapter.js";
import { OPENAI_RESPONSES_PROVIDER } from "../provider/openai-responses.js";
import { ZEN_MESSAGES_PROVIDER } from "../provider/zen-anthropic-adapter.js";
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
});

describe("contextWindow / maxTokens split (CL-7784)", () => {
  test("setting contextWindow does not change the source output budget", () => {
    const source = buildInferenceSourceForRef(
      { provider: "fp", model: "fp-large" },
      ctx(),
      settingsWithWindow(),
    );
    expect(source?.defaults?.maxTokens).toBe(SOURCE_MAX_TOKENS);
  });

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

  test("every preset model has an explicit quirk decision", () => {
    const flagged = new Set(openaiApi?.maxCompletionTokensModels ?? []);
    // Explicit max_tokens decision: non-reasoning preset models stay on
    // max_tokens. Adding a preset model requires a decision here AND in the
    // preset's maxCompletionTokensModels — the union below fails loudly
    // otherwise instead of silently sending max_tokens.
    const explicitMaxTokensModels = new Set(["gpt-4.1"]);
    expect([...flagged, ...explicitMaxTokensModels].sort()).toEqual(
      [...new Set(presetModels)].sort(),
    );
    expect([...flagged].filter((m) => explicitMaxTokensModels.has(m))).toEqual(
      [],
    );
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
    expect(source?.provider).toBe(ZEN_PROVIDER_ID);
    expect(source?.baseURL).toBe(ZEN_DEFAULT_BASE_URL);
  });

  test("unknown ids default to chat completions, never name-prefix inference", () => {
    const source = zenSource("some-future-model");
    expect(source?.provider).toBe(ZEN_PROVIDER_ID);
    expect(source?.baseURL).toBe(ZEN_DEFAULT_BASE_URL);
  });
});
