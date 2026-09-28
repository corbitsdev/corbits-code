import { describe, expect, test } from "bun:test";
import type { InferenceOptions } from "@intx/types/runtime";
import {
  createOpenCodeGoAnthropicAdapter,
  createZenAnthropicAdapter,
} from "./anthropic-session-adapter.js";

const messages = [
  {
    role: "user" as const,
    timestamp: 0,
    content: [{ type: "text" as const, text: "hi" }],
  },
];

const factories = {
  "opencode-go": createOpenCodeGoAnthropicAdapter,
  zen: createZenAnthropicAdapter,
} as const;

describe("session header Anthropic adapter", () => {
  for (const [name, factory] of Object.entries(factories)) {
    test(`${name}: delegates Anthropic request construction and adds only the session header`, () => {
      const request = factory({
        sourceId: name,
        provider: `${name}-messages`,
        model: "minimax-m3",
      }).buildRequest(messages, "minimax-m3", {
        providerOptions: { opencodeSessionId: "sess-1" },
      } as InferenceOptions);
      expect(request.headers["x-opencode-session"]).toBe("sess-1");
      expect(JSON.parse(request.body)).not.toHaveProperty("opencodeSessionId");
      expect(JSON.parse(request.body)).toMatchObject({
        model: "minimax-m3",
        stream: true,
      });
    });

    test(`${name}: omits the session header when no session is supplied`, () => {
      const request = factory({
        sourceId: name,
        provider: `${name}-messages`,
        model: "minimax-m3",
      }).buildRequest(messages, "minimax-m3", {});
      expect(request.headers["x-opencode-session"]).toBeUndefined();
    });
  }
});
