import { describe, expect, test } from "bun:test";
import {
  ephemeralInjectRole,
  midConversationSystemSupported,
} from "./ephemeral-inject-role.js";

const SUPPORT_TABLE = [
  ["anthropic", "claude-sonnet-4-6", false],
  ["zen-messages", "claude-sonnet-4-6", false],
  ["anthropic", "claude-fable-5-1", true],
  ["zen-messages", "claude-fable-5", true],
  ["opencode-go-messages", "mythos", true],
  ["anthropic", "claude-opus-4-8", true],
  ["anthropic", "claude-opus-4.8", true],
  ["anthropic", "claude-opus-5", true],
  ["anthropic", "claude-opus-4-6", false],
  ["openai", "claude-fable-5-1", false],
  ["grok-responses", "grok-4", false],
  ["openai", "gpt-5", false],
] as const;

describe("midConversationSystemSupported", () => {
  test.each(SUPPORT_TABLE)("%s / %s → %s", (provider, model, supported) => {
    expect(midConversationSystemSupported(provider, model)).toBe(supported);
  });
});

describe("ephemeralInjectRole", () => {
  test.each(SUPPORT_TABLE.map(([provider, model]) => [provider, model]))(
    "%s / %s → user until the adapter preserves mid-conversation system",
    (provider, model) => {
      expect(ephemeralInjectRole(provider, model)).toBe("user");
    },
  );
});
