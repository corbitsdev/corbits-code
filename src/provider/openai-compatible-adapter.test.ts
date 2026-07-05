import { describe, test, expect } from "bun:test";
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
    const body = JSON.parse(built.body) as { messages: Array<{ content: unknown }> };

    expect(body.messages[0]?.content).toEqual([
      "what is this?",
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

describe("openai-compatible adapter reasoning_content handling", () => {
  const withThinking: ConversationTurn[] = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", model: "deepseek-v4", content: [{ type: "thinking", thinking: "ponder" }, { type: "text", text: "hello" }] },
    { role: "user", content: [{ type: "text", text: "again" }] },
  ] as unknown as ConversationTurn[];

  function messagesFor(model: string): Array<Record<string, unknown>> {
    const adapter = createOpenAICompatibleAdapter({ ...source, model } as typeof source);
    const built = adapter.buildRequest(withThinking, model, {} as InferenceOptions);
    return (JSON.parse(built.body) as { messages: Array<Record<string, unknown>> }).messages;
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
