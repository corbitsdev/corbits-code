import { describe, test, expect } from "bun:test";
import type { ConversationTurn, InferenceOptions } from "@intx/types/runtime";
import {
  createDeepSeekV4Adapter,
  DEEPSEEK_V4_PROVIDER,
} from "./deepseek-v4-adapter.js";
import { createOpenAICompatibleAdapter } from "./openai-compatible-adapter.js";

const source = {
  id: "test",
  provider: DEEPSEEK_V4_PROVIDER,
  baseURL: "https://example.test",
  apiKey: "sk-test",
  model: "deepseek-v4-pro",
} as unknown as Parameters<typeof createDeepSeekV4Adapter>[0];

const messages: ConversationTurn[] = [
  {
    role: "user",
    content: [{ type: "text", text: "hi" }],
  } as unknown as ConversationTurn,
];

function bodyFor(options: InferenceOptions): Record<string, unknown> {
  const adapter = createDeepSeekV4Adapter(source);
  const built = adapter.buildRequest(messages, "deepseek-v4-pro", options);
  return JSON.parse(built.body) as Record<string, unknown>;
}

describe("deepseek-v4 adapter effort wiring", () => {
  test.each(["xhigh", "max"] as const)(
    "wires V4 effort %s through raw and turns thinking on",
    (effort) => {
      const body = bodyFor({
        providerOptions: { reasoning_effort: effort },
      } as InferenceOptions);
      expect(body["reasoning_effort"]).toBe(effort);
      expect(body["chat_template_kwargs"]).toEqual({ thinking: true });
    },
  );

  test("none → chat_template_kwargs.thinking false and NO reasoning_effort", () => {
    const body = bodyFor({
      providerOptions: { reasoning_effort: "none" },
    } as InferenceOptions);
    expect(body["chat_template_kwargs"]).toEqual({ thinking: false });
    expect("reasoning_effort" in body).toBe(false);
  });

  test("off-ladder effort is left untouched (no high→xhigh coercion)", () => {
    const body = bodyFor({
      providerOptions: { reasoning_effort: "high" },
    } as InferenceOptions);
    expect(body["reasoning_effort"]).toBe("high");
    expect("chat_template_kwargs" in body).toBe(false);
  });

  test("unset effort does not inject empty chat_template_kwargs", () => {
    const body = bodyFor({} as InferenceOptions);
    expect("chat_template_kwargs" in body).toBe(false);
    expect(body["reasoning_effort"]).toBeUndefined();
  });
});

describe("deepseek-v4 adapter request settings", () => {
  test("stream_options include_usage is true", () => {
    const body = bodyFor({} as InferenceOptions);
    expect(body["stream_options"]).toEqual({ include_usage: true });
  });

  test("top_p 0.95 and temperature 1.0 defaulted when absent", () => {
    const body = bodyFor({} as InferenceOptions);
    expect(body["top_p"]).toBe(0.95);
    expect(body["temperature"]).toBe(1.0);
  });

  test("top_p and temperature preserved when providerOptions set them", () => {
    const body = bodyFor({
      providerOptions: { temperature: 0.7, top_p: 0.9 },
    } as InferenceOptions);
    expect(body["top_p"]).toBe(0.9);
    expect(body["temperature"]).toBe(0.7);
  });

  test("provider-set stream_options is preserved (absent-only)", () => {
    const body = bodyFor({
      providerOptions: { stream_options: { include_usage: false } },
    } as InferenceOptions);
    expect(body["stream_options"]).toEqual({ include_usage: false });
  });

  test("chat_template_kwargs merge preserves existing keys", () => {
    const body = bodyFor({
      providerOptions: {
        reasoning_effort: "xhigh",
        chat_template_kwargs: { some: "existing" },
      },
    } as InferenceOptions);
    expect(body["chat_template_kwargs"]).toEqual({
      thinking: true,
      some: "existing",
    });
  });

  test("provider-set thinking is preserved (absent-only thinking)", () => {
    const noneThenTrue = bodyFor({
      providerOptions: {
        reasoning_effort: "none",
        chat_template_kwargs: { thinking: true },
      },
    } as InferenceOptions);
    expect(noneThenTrue["chat_template_kwargs"]).toEqual({ thinking: true });

    const xhighThenFalse = bodyFor({
      providerOptions: {
        reasoning_effort: "xhigh",
        chat_template_kwargs: { thinking: false },
      },
    } as InferenceOptions);
    expect(xhighThenFalse["chat_template_kwargs"]).toEqual({ thinking: false });
  });
});

describe("deepseek-v4 adapter inherits base quirks", () => {
  const withThinking: ConversationTurn[] = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      model: "deepseek-v4",
      content: [
        { type: "thinking", thinking: "ponder" },
        { type: "text", text: "hello" },
      ],
    },
    { role: "user", content: [{ type: "text", text: "again" }] },
  ] as unknown as ConversationTurn[];

  test("keeps reasoning_content on replayed assistant turns (inherited base)", () => {
    const adapter = createDeepSeekV4Adapter(source);
    const built = adapter.buildRequest(
      withThinking,
      "deepseek-v4",
      {} as InferenceOptions,
    );
    const assistant = (
      JSON.parse(built.body) as { messages: Record<string, unknown>[] }
    ).messages.find((m) => m["role"] === "assistant");
    expect(assistant?.["reasoning_content"]).toBe("ponder");
  });

  test("vendor-qualified V4 id keeps reasoning_content on replays (org/ prefix)", () => {
    const adapter = createDeepSeekV4Adapter(source);
    const built = adapter.buildRequest(
      withThinking,
      "deepseek-ai/DeepSeek-V4-Flash-0731",
      {
        providerOptions: { reasoning_effort: "xhigh" },
      } as InferenceOptions,
    );
    const body = JSON.parse(built.body) as {
      messages: Record<string, unknown>[];
      reasoning_effort?: unknown;
    };
    const assistant = body.messages.find((m) => m["role"] === "assistant");
    expect(assistant?.["reasoning_content"]).toBe("ponder");
    expect(body.reasoning_effort).toBe("xhigh");
  });

  test("non-V4 select a generic body build (base short-circuits, no V4 fields)", () => {
    const adapter = createDeepSeekV4Adapter({
      ...source,
      model: "gpt-5",
    } as typeof source);
    const built = adapter.buildRequest(
      messages,
      "gpt-5",
      {} as InferenceOptions,
    );
    const body = JSON.parse(built.body) as Record<string, unknown>;
    expect("top_p" in body).toBe(false);
    expect("temperature" in body).toBe(false);
    expect("stream_options" in body).toBe(false);
    expect("chat_template_kwargs" in body).toBe(false);
    expect(body["model"]).toBe("gpt-5");
  });

  test("keeps reasoning_content for non-DeepSeek models", () => {
    const adapter = createDeepSeekV4Adapter({
      ...source,
      model: "kimi-k2",
    } as typeof source);
    const built = adapter.buildRequest(
      withThinking,
      "kimi-k2",
      {} as InferenceOptions,
    );
    const assistant = (
      JSON.parse(built.body) as { messages: Record<string, unknown>[] }
    ).messages.find((m) => m["role"] === "assistant");
    expect(assistant?.["reasoning_content"]).toBe("ponder");
  });
});

describe("deepseek-v4 adapter byte-identical to base for non-V4", () => {
  test("non-V4 body matches the patched generic base byte-for-byte", () => {
    const baseAdapter = createOpenAICompatibleAdapter({
      ...source,
      model: "gpt-5",
    } as typeof source);
    const baseBuilt = baseAdapter.buildRequest(messages, "gpt-5", {
      providerOptions: { reasoning_effort: "none" },
    } as InferenceOptions);

    const adapter = createDeepSeekV4Adapter({
      ...source,
      model: "gpt-5",
    } as typeof source);
    const built = adapter.buildRequest(messages, "gpt-5", {
      providerOptions: { reasoning_effort: "none" },
    } as InferenceOptions);

    const baseBody = JSON.parse(baseBuilt.body) as Record<string, unknown>;
    const body = JSON.parse(built.body) as Record<string, unknown>;
    expect(body).toEqual(baseBody);
  });
});
