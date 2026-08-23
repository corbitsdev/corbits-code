import { describe, expect, test } from "bun:test";
import type { ConversationTurn, LastCycleSource } from "@intx/types/runtime";
import {
  createCodexResponsesAdapter,
  isResponsesStreamTerminal,
} from "./codex-responses-adapter.js";

const source: LastCycleSource = {
  sourceId: "codex/test",
  provider: "codex-responses",
  model: "gpt-5.1-codex",
};

describe("createCodexResponsesAdapter", () => {
  test("sends user image blocks as Responses input_image parts", () => {
    const adapter = createCodexResponsesAdapter(source);
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

    const request = adapter.buildRequest(turns, "gpt-5.1-codex", {});
    const body = JSON.parse(request.body) as {
      input: { type: string; role?: string; content?: unknown }[];
    };

    expect(body.input[0]).toEqual({
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "what is this?" },
        { type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" },
      ],
    });
  });

  test("keeps text-only messages as Responses text parts", () => {
    const adapter = createCodexResponsesAdapter(source);
    const turns: ConversationTurn[] = [
      {
        role: "user",
        timestamp: 0,
        content: [{ type: "text", text: "hello" }],
      },
    ];

    const request = adapter.buildRequest(turns, "gpt-5.1-codex", {});
    const body = JSON.parse(request.body) as { input: { content?: unknown }[] };

    expect(body.input[0]?.content).toEqual([{ type: "input_text", text: "hello" }]);
  });

  test("reports the adapter as terminating on response.completed", () => {
    const adapter = createCodexResponsesAdapter(source);
    expect(adapter.isStreamTerminal).toBe(isResponsesStreamTerminal);
  });
});

describe("createCodexResponsesAdapter usage parsing", () => {
  test("maps a nonzero cache_creation_tokens count through to cacheWrite", () => {
    const adapter = createCodexResponsesAdapter(source);
    const sseData = JSON.stringify({
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 20, cache_creation_tokens: 15 },
          output_tokens: 50,
          output_tokens_details: { reasoning_tokens: 5 },
        },
      },
    });

    const events = adapter.parseResponse(sseData);
    const usageEvent = events.find((e) => e.type === "inference.usage");

    expect(usageEvent?.data).toEqual({
      usage: { input: 100, output: 50, cacheRead: 20, cacheWrite: 15, thinking: 5 },
      source,
    });
  });

  test("defaults cacheWrite to 0 when the provider does not report a cache-creation count", () => {
    const adapter = createCodexResponsesAdapter(source);
    const sseData = JSON.stringify({
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 20 },
          output_tokens: 50,
          output_tokens_details: { reasoning_tokens: 5 },
        },
      },
    });

    const events = adapter.parseResponse(sseData);
    const usageEvent = events.find((e) => e.type === "inference.usage");

    expect(usageEvent?.data).toEqual({
      usage: { input: 100, output: 50, cacheRead: 20, cacheWrite: 0, thinking: 5 },
      source,
    });
  });
});

describe("isResponsesStreamTerminal", () => {
  test("is true for the Responses end-of-turn events", () => {
    for (const type of ["response.completed", "response.incomplete", "response.done"]) {
      expect(isResponsesStreamTerminal(JSON.stringify({ type }))).toBe(true);
    }
  });

  test("is false for streaming and lifecycle events", () => {
    for (const type of ["response.output_text.delta", "response.created", "response.in_progress"]) {
      expect(isResponsesStreamTerminal(JSON.stringify({ type }))).toBe(false);
    }
  });

  test("is false for malformed or non-object payloads", () => {
    expect(isResponsesStreamTerminal("{not json")).toBe(false);
    expect(isResponsesStreamTerminal("null")).toBe(false);
    expect(isResponsesStreamTerminal('"just a string"')).toBe(false);
  });
});
