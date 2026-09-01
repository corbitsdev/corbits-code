import { describe, expect, test } from "bun:test";

import { ProtocolMismatchError } from "../errors";
import { createOpenAIAdapter } from "./openai";

const source = {
  sourceId: "test-openai",
  provider: "openai-compatible",
  model: "test-model",
};

const nullToolCallsChunk = JSON.stringify({
  choices: [{ index: 0, delta: { content: "hello", tool_calls: null } }],
});

describe("OpenAI null tool_calls response quirk", () => {
  test("normalizes null tool_calls to absence when enabled", () => {
    const adapter = createOpenAIAdapter(source, { normalizeNullToolCalls: true });

    expect(adapter.parseResponse(nullToolCallsChunk)).toContainEqual({
      type: "inference.text.delta",
      seq: 0,
      data: { token: "hello", partial: { text: "" }, index: 0 },
    });
  });

  test("rejects null tool_calls by default", () => {
    const adapter = createOpenAIAdapter(source);

    expect(() => adapter.parseResponse(nullToolCallsChunk)).toThrow(ProtocolMismatchError);
  });

  test("rejects malformed non-null tool_calls when enabled", () => {
    const adapter = createOpenAIAdapter(source, { normalizeNullToolCalls: true });
    const malformedChunk = JSON.stringify({
      choices: [{ index: 0, delta: { content: "hello", tool_calls: "invalid" } }],
    });

    expect(() => adapter.parseResponse(malformedChunk)).toThrow(ProtocolMismatchError);
  });
});
