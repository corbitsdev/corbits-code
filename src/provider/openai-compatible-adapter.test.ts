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
