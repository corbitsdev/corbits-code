import { describe, expect, test } from "bun:test";
import type { ConversationTurn, LastCycleSource } from "@intx/types/runtime";
import { createGrokResponsesAdapter } from "./grok-responses-adapter.js";

const source: LastCycleSource = {
  sourceId: "xai/test",
  provider: "grok-responses",
  model: "grok-4.5",
};

describe("createGrokResponsesAdapter", () => {
  test("sends user image blocks as Responses input_image parts", () => {
    const adapter = createGrokResponsesAdapter(source);
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

    const request = adapter.buildRequest(turns, "grok-4.5", {});
    const body = JSON.parse(request.body) as { input: Array<{ type: string; role?: string; content?: unknown }> };

    expect(body.input).toHaveLength(1);
    expect(body.input[0]).toEqual({
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "what is this?" },
        { type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" },
      ],
    });
  });

  test("keeps text-only messages in the string content shape", () => {
    const adapter = createGrokResponsesAdapter(source);
    const turns: ConversationTurn[] = [
      {
        role: "user",
        timestamp: 0,
        content: [{ type: "text", text: "hello" }],
      },
    ];

    const request = adapter.buildRequest(turns, "grok-4.5", {});
    const body = JSON.parse(request.body) as { input: Array<{ content?: unknown }> };

    expect(body.input[0]?.content).toBe("hello");
  });
});
