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
  { role: "user", content: [{ type: "text", text: "hi" }] } as unknown as ConversationTurn,
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
          { type: "image", source: { kind: "base64", mimeType: "image/png", data: "aW1hZ2U=" } },
        ],
      },
    ];
    const built = adapter.buildRequest(turns, "gpt-5.1", {} as InferenceOptions);
    const body = JSON.parse(built.body) as { messages: { content: unknown }[] };

    expect(body.messages[0]?.content).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
    ]);
  });
});

describe("openai-compatible adapter providerOptions passthrough", () => {
  test("merges reasoning_effort from providerOptions into the request body", () => {
    const body = bodyFor({ providerOptions: { reasoning_effort: "high" } } as InferenceOptions);
    expect(body["reasoning_effort"]).toBe("high");
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
      return (originalParse as (t: string, r?: unknown) => unknown)(text, reviver);
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
    const adapter = createOpenAICompatibleAdapter({ ...source, model } as typeof source);
    const built = adapter.buildRequest(withThinking, model, {} as InferenceOptions);
    return (JSON.parse(built.body) as { messages: Record<string, unknown>[] }).messages;
  }

  test("strips reasoning_content from input messages for DeepSeek models", () => {
    const assistant = messagesFor("deepseek-v4").find((m) => m["role"] === "assistant");
    expect(assistant).toBeDefined();
    expect("reasoning_content" in assistant!).toBe(false);
  });

  test("keeps reasoning_content for non-DeepSeek models", () => {
    const assistant = messagesFor("kimi-k2").find((m) => m["role"] === "assistant");
    expect(assistant?.["reasoning_content"]).toBe("ponder");
  });
});
