import { describe, expect, test } from "bun:test";
import type { InferenceOptions } from "@intx/types/runtime";
import { createOpenCodeGoAnthropicAdapter } from "./opencode-go-anthropic-adapter.js";

const source = {
  sourceId: "opencode-go",
  provider: "opencode-go-messages",
  model: "minimax-m3",
};

const messages = [
  { role: "user" as const, timestamp: 0, content: [{ type: "text" as const, text: "hi" }] },
];

describe("OpenCode Go Messages adapter", () => {
  test("delegates Anthropic request construction and adds only the session header", () => {
    const request = createOpenCodeGoAnthropicAdapter(source).buildRequest(messages, "minimax-m3", {
      providerOptions: { opencodeSessionId: "sess-1" },
    } as InferenceOptions);
    expect(request.headers["x-opencode-session"]).toBe("sess-1");
    expect(JSON.parse(request.body)).not.toHaveProperty("opencodeSessionId");
    expect(JSON.parse(request.body)).toMatchObject({ model: "minimax-m3", stream: true });
  });

  test("omits the session header when no session is supplied", () => {
    const request = createOpenCodeGoAnthropicAdapter(source).buildRequest(
      messages,
      "minimax-m3",
      {},
    );
    expect(request.headers["x-opencode-session"]).toBeUndefined();
  });
});
