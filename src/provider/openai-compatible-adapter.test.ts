import { defined } from "../../testkit/defined.js";
import { describe, test, expect } from "bun:test";
import { ProtocolMismatchError } from "@intx/inference";
import type { ConversationTurn, InferenceOptions } from "@intx/types/runtime";
import { createOpenAICompatibleAdapter } from "./openai-compatible-adapter.js";

const source = {
  id: "test",
  provider: "openai-compatible",
  baseURL: "https://example.test",
  apiKey: "sk-test",
  model: "gpt-5.1",
} as unknown as Parameters<typeof createOpenAICompatibleAdapter>[0];

const messages: ConversationTurn[] = [
  {
    role: "user",
    content: [{ type: "text", text: "hi" }],
  } as unknown as ConversationTurn,
];

function bodyFor(options: InferenceOptions): Record<string, unknown> {
  const adapter = createOpenAICompatibleAdapter(source);
  const built = adapter.buildRequest(messages, "gpt-5.1", options);
  return JSON.parse(built.body) as Record<string, unknown>;
}

describe("openai-compatible adapter image input", () => {
  test("preserves user image blocks as OpenAI image_url content", () => {
    const adapter = createOpenAICompatibleAdapter(source);
    const turns: ConversationTurn[] = [
      {
        role: "user",
        timestamp: 0,
        content: [
          { type: "text", text: "what is this?" },
          {
            type: "image",
            source: { kind: "base64", mimeType: "image/png", data: "aW1hZ2U=" },
          },
        ],
      },
    ];
    const built = adapter.buildRequest(
      turns,
      "gpt-5.1",
      {} as InferenceOptions,
    );
    const body = JSON.parse(built.body) as { messages: { content: unknown }[] };

    expect(body.messages[0]?.content).toEqual([
      { type: "text", text: "what is this?" },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,aW1hZ2U=" },
      },
    ]);
  });
});

describe("openai-compatible adapter providerOptions passthrough", () => {
  test("merges reasoning_effort from providerOptions into the request body", () => {
    const body = bodyFor({
      providerOptions: { reasoning_effort: "high" },
    } as InferenceOptions);
    expect(body["reasoning_effort"]).toBe("high");
  });

  test("merges temperature and top_p together from providerOptions", () => {
    const body = bodyFor({
      providerOptions: { temperature: 0.7, top_p: 0.9 },
    } as InferenceOptions);
    expect(body["temperature"]).toBe(0.7);
    expect(body["top_p"]).toBe(0.9);
  });

  test("leaves the body untouched when no providerOptions are present", () => {
    const body = bodyFor({} as InferenceOptions);
    expect("reasoning_effort" in body).toBe(false);
    expect(body["model"]).toBe("gpt-5.1");
  });
});

describe("openai-compatible adapter SSE parse count", () => {
  test("parses a non-DeepSeek frame with JSON.parse exactly once", () => {
    const adapter = createOpenAICompatibleAdapter(source);
    adapter.buildRequest(messages, "gpt-5.1", {} as InferenceOptions);

    const sseData = JSON.stringify({
      choices: [{ delta: { role: "assistant", content: "hi" } }],
    });
    const originalParse = JSON.parse;
    let calls = 0;
    JSON.parse = ((text: string, reviver?: unknown) => {
      calls += 1;
      return (originalParse as (t: string, r?: unknown) => unknown)(
        text,
        reviver,
      );
    }) as typeof JSON.parse;
    try {
      adapter.parseResponse(sseData);
    } finally {
      JSON.parse = originalParse;
    }

    expect(calls).toBe(1);
  });
});

describe("openai-compatible adapter null delta fields", () => {
  test.each(["role", "tool_calls"])("rejects null %s", (field) => {
    const adapter = createOpenAICompatibleAdapter(source);
    expect(() =>
      adapter.parseResponse(
        JSON.stringify({
          choices: [{ index: 0, delta: { content: "hello", [field]: null } }],
        }),
      ),
    ).toThrow(ProtocolMismatchError);
  });
});

describe("openai-compatible adapter reasoning_content handling", () => {
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

  function messagesFor(model: string): Record<string, unknown>[] {
    const adapter = createOpenAICompatibleAdapter({
      ...source,
      model,
    } as typeof source);
    const built = adapter.buildRequest(
      withThinking,
      model,
      {} as InferenceOptions,
    );
    return (JSON.parse(built.body) as { messages: Record<string, unknown>[] })
      .messages;
  }

  test("strips reasoning_content from input messages for DeepSeek models", () => {
    const assistant = messagesFor("deepseek-v4").find(
      (m) => m["role"] === "assistant",
    );
    expect(assistant).toBeDefined();
    expect("reasoning_content" in defined(assistant)).toBe(false);
  });

  test("keeps reasoning_content for non-DeepSeek models", () => {
    const assistant = messagesFor("kimi-k2").find(
      (m) => m["role"] === "assistant",
    );
    expect(assistant?.["reasoning_content"]).toBe("ponder");
  });
});

describe("openai-compatible adapter DeepSeek V4 Flash wire params", () => {
  const V4 = "deepseek-ai/DeepSeek-V4-Flash-0731";
  const history: ConversationTurn[] = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "ponder" },
        { type: "text", text: "hello" },
      ],
    },
    { role: "user", content: [{ type: "text", text: "again" }] },
  ] as unknown as ConversationTurn[];

  function v4Body(
    providerOptions?: Record<string, unknown>,
    model = V4,
  ): Record<string, unknown> {
    const adapter = createOpenAICompatibleAdapter(source);
    const built = adapter.buildRequest(history, model, {
      maxTokens: 100,
      ...(providerOptions !== undefined ? { providerOptions } : {}),
    } as InferenceOptions);
    return JSON.parse(built.body) as Record<string, unknown>;
  }

  test("turns thinking on and applies agentic sampling at high effort", () => {
    const body = v4Body({ reasoning_effort: "high" });
    expect(body["chat_template_kwargs"]).toEqual({ thinking: true });
    expect(body["reasoning_effort"]).toBe("high");
    expect(body["temperature"]).toBe(1);
    expect(body["top_p"]).toBe(0.95);
    expect(body["stream_options"]).toEqual({ include_usage: true });
  });

  test("folds Corbits' ladder onto low/high/max", () => {
    expect(v4Body({ reasoning_effort: "minimal" })["reasoning_effort"]).toBe(
      "low",
    );
    expect(v4Body({ reasoning_effort: "medium" })["reasoning_effort"]).toBe(
      "high",
    );
    expect(v4Body({ reasoning_effort: "max" })["reasoning_effort"]).toBe("max");
  });

  test("effort none sends chat mode explicitly and no effort", () => {
    const body = v4Body({ reasoning_effort: "none" });
    expect(body["chat_template_kwargs"]).toEqual({ thinking: false });
    expect("reasoning_effort" in body).toBe(false);
    expect("top_p" in body).toBe(false);
  });

  test("an explicitly configured temperature/top_p wins", () => {
    const body = v4Body({
      reasoning_effort: "high",
      temperature: 0.6,
      top_p: 0.9,
    });
    expect(body["temperature"]).toBe(0.6);
    expect(body["top_p"]).toBe(0.9);
  });

  test("replays reasoning_content on prior assistant turns", () => {
    const msgs = v4Body({ reasoning_effort: "high" })["messages"] as Record<
      string,
      unknown
    >[];
    const assistant = msgs.find((m) => m["role"] === "assistant");
    expect(assistant?.["reasoning_content"]).toBe("ponder");
  });

  test("other DeepSeek models keep the old strip and get no extra params", () => {
    const body = v4Body({ reasoning_effort: "high" }, "deepseek-v3.2");
    expect("chat_template_kwargs" in body).toBe(false);
    expect("top_p" in body).toBe(false);
    const msgs = body["messages"] as Record<string, unknown>[];
    const assistant = msgs.find((m) => m["role"] === "assistant");
    expect("reasoning_content" in defined(assistant)).toBe(false);
  });
});
