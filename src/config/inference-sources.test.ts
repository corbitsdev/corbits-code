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

const WINDOW = 400_000;

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
