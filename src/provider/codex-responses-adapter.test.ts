import { describe, expect, test } from "bun:test";
import type { ConversationTurn, LastCycleSource } from "@intx/types/runtime";
import { createCodexResponsesAdapter } from "./codex-responses-adapter.js";

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
    const body = JSON.parse(request.body) as { input: Array<{ type: string; role?: string; content?: unknown }> };

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
    const body = JSON.parse(request.body) as { input: Array<{ content?: unknown }> };

    expect(body.input[0]?.content).toEqual([{ type: "input_text", text: "hello" }]);
  });
});
