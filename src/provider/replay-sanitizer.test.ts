import { describe, expect, it } from "bun:test";
import type { AdapterRegistry } from "@intx/inference";
import { createBuiltinRegistry } from "@intx/inference/providers";
import type { ConversationTurn, LastCycleSource } from "@intx/types/runtime";
import { createGrokResponsesAdapter } from "./grok-responses-adapter.js";
import { createOpenAICompatibleAdapter } from "./openai-compatible-adapter.js";
import {
  sanitizeReplayTurns,
  THINKING_ONLY_OMITTED,
  withReplaySanitizer,
} from "./replay-sanitizer.js";

const GROK_SIGNATURE = "grok-opaque-signature-blob";

function grokThinkingHistory(): ConversationTurn[] {
  return [
    {
      role: "user",
      content: [{ type: "text", text: "hello" }],
      timestamp: 1,
    },
    {
      role: "assistant",
      model: "grok-4",
      content: [
        { type: "thinking", thinking: "pondering", signature: GROK_SIGNATURE },
        { type: "text", text: "answer", signature: GROK_SIGNATURE },
      ],
      timestamp: 2,
    },
    {
      role: "user",
      content: [{ type: "text", text: "continue" }],
      timestamp: 3,
    },
  ];
}

function resolveSanitized(source: LastCycleSource) {
  return withReplaySanitizer(createBuiltinRegistry()).resolve(source);
}

function corbitsRegistry(): AdapterRegistry {
  const builtin = createBuiltinRegistry();
  return {
    has: (provider) =>
      provider === "openai-compatible" || provider === "grok-responses" || builtin.has(provider),
    resolve(source, quirks) {
      if (source.provider === "openai-compatible") {
        return createOpenAICompatibleAdapter(source);
      }
      if (source.provider === "grok-responses") {
        return createGrokResponsesAdapter(source);
      }
      return builtin.resolve(source, quirks);
    },
  };
}

function thinkingOnlyHistory(): ConversationTurn[] {
  return [
    {
      role: "user",
      content: [{ type: "text", text: "hello" }],
      timestamp: 1,
    },
    {
      role: "assistant",
      model: "grok-4",
      content: [{ type: "thinking", thinking: "pondering" }],
      timestamp: 2,
    },
    {
      role: "user",
      content: [{ type: "text", text: "continue" }],
      timestamp: 3,
    },
  ];
}

const USER_ONLY: ConversationTurn[] = [
  {
    role: "user",
    content: [{ type: "text", text: "hello" }],
    timestamp: 1,
  },
];

const THINKING_ONLY_TAIL: ConversationTurn = {
  role: "assistant",
  model: "grok-4",
  content: [{ type: "thinking", thinking: "pondering" }],
  timestamp: 2,
};

describe("sanitizeReplayTurns", () => {
  it("strips foreign thinking blocks and signatures", () => {
    const turns = sanitizeReplayTurns(grokThinkingHistory(), "claude-opus-4");
    const assistant = turns.find((t) => t.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant?.content.some((b) => b.type === "thinking")).toBe(false);
    expect(JSON.stringify(turns)).not.toContain(GROK_SIGNATURE);
  });

  it("keeps thinking blocks for same-model replay", () => {
    const turns = sanitizeReplayTurns(grokThinkingHistory(), "grok-4");
    const assistant = turns.find((t) => t.role === "assistant");
    expect(assistant?.content.some((b) => b.type === "thinking")).toBe(true);
  });

  it("converts foreign refusal blocks to text", () => {
    const turns = sanitizeReplayTurns(
      [
        {
          role: "assistant",
          model: "gpt-5",
          content: [{ type: "refusal", reason: "cannot comply" }],
          timestamp: 1,
        },
      ],
      "claude-opus-4",
    );
    expect(turns[0]?.content).toEqual([{ type: "text", text: "cannot comply" }]);
  });

  it("drops foreign redacted_thinking and citation blocks", () => {
    const turns = sanitizeReplayTurns(
      [
        {
          role: "assistant",
          model: "claude-opus-4",
          content: [
            { type: "redacted_thinking", data: "opaque" },
            { type: "text", text: "cited answer" },
            { type: "citation", citedText: "quote", source: {} },
          ],
          timestamp: 1,
        },
      ],
      "gemini-2.5-pro",
    );
    expect(turns[0]?.content).toEqual([{ type: "text", text: "cited answer" }]);
  });

  it("answers dangling tool_calls with a synthetic error result", () => {
    const turns = sanitizeReplayTurns(
      [
        {
          role: "assistant",
          model: "grok-4",
          content: [
            { type: "text", text: "running tool" },
            { type: "tool_call", id: "call_1", name: "ls", arguments: {} },
          ],
          timestamp: 1,
        },
      ],
      "claude-opus-4",
    );
    const results = turns.flatMap((t) => t.content.filter((b) => b.type === "tool_result"));
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ callId: "call_1", isError: true });
  });

  it("replaces a thinking-only assistant between users with a marker and keeps roles", () => {
    const turns = sanitizeReplayTurns(thinkingOnlyHistory(), "claude-opus-4");
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "user"]);
    expect(turns[1]?.content).toEqual([{ type: "text", text: THINKING_ONLY_OMITTED }]);
  });

  it("replaces empty and leftover-only assistant turns with the same marker", () => {
    const empty = sanitizeReplayTurns(
      [
        {
          role: "assistant",
          model: "grok-4",
          content: [],
          timestamp: 1,
        },
      ],
      "claude-opus-4",
    );
    expect(empty[0]?.content).toEqual([{ type: "text", text: THINKING_ONLY_OMITTED }]);

    const leftovers = sanitizeReplayTurns(
      [
        {
          role: "assistant",
          model: "claude-opus-4",
          content: [
            { type: "thinking", thinking: "pondering" },
            { type: "redacted_thinking", data: "opaque" },
            { type: "citation", citedText: "quote", source: {} },
          ],
          timestamp: 1,
        },
      ],
      "gemini-2.5-pro",
    );
    expect(leftovers[0]?.content).toEqual([{ type: "text", text: THINKING_ONLY_OMITTED }]);
    expect(JSON.stringify(leftovers)).not.toContain("pondering");
    expect(JSON.stringify(leftovers)).not.toContain("opaque");
  });

  it("leaves assistant turns with text and/or tool_call unchanged", () => {
    const withText = sanitizeReplayTurns(grokThinkingHistory(), "grok-4");
    expect(withText[1]?.content).toEqual([
      { type: "thinking", thinking: "pondering", signature: GROK_SIGNATURE },
      { type: "text", text: "answer", signature: GROK_SIGNATURE },
    ]);

    const withTool = [
      {
        role: "assistant" as const,
        model: "grok-4",
        content: [
          { type: "thinking" as const, thinking: "need a tool" },
          { type: "tool_call" as const, id: "call_1", name: "ls", arguments: {} },
        ],
        timestamp: 1,
      },
    ];
    const kept = sanitizeReplayTurns(withTool, "grok-4");
    expect(kept[0]?.content).toEqual(withTool[0]?.content);
  });
});

describe("withReplaySanitizer", () => {
  it("builds an Anthropic request from a grok-signed thinking turn", () => {
    const adapter = resolveSanitized({
      sourceId: "s1",
      provider: "anthropic",
      model: "claude-opus-4",
    });
    const request = adapter.buildRequest(grokThinkingHistory(), "claude-opus-4", {});
    expect(request.body).not.toContain(GROK_SIGNATURE);
    expect(request.body).not.toContain('"thinking"');
  });

  it("builds a Google request from a grok-signed thinking turn", () => {
    const adapter = resolveSanitized({
      sourceId: "s1",
      provider: "google-genai",
      model: "gemini-2.5-pro",
    });
    const request = adapter.buildRequest(grokThinkingHistory(), "gemini-2.5-pro", {});
    expect(request.body).not.toContain(GROK_SIGNATURE);
    expect(request.body).not.toContain("thoughtSignature");
  });

  it("builds an Anthropic request from a persisted refusal block", () => {
    const adapter = resolveSanitized({
      sourceId: "s1",
      provider: "anthropic",
      model: "claude-opus-4",
    });
    const request = adapter.buildRequest(
      [
        {
          role: "user",
          content: [{ type: "text", text: "do it" }],
          timestamp: 1,
        },
        {
          role: "assistant",
          model: "gpt-5",
          content: [{ type: "refusal", reason: "cannot comply" }],
          timestamp: 2,
        },
        {
          role: "user",
          content: [{ type: "text", text: "why not" }],
          timestamp: 3,
        },
      ],
      "claude-opus-4",
      {},
    );
    expect(request.body).toContain("cannot comply");
  });

  it("builds an Anthropic request from a dangling tool_call", () => {
    const adapter = resolveSanitized({
      sourceId: "s1",
      provider: "anthropic",
      model: "claude-opus-4",
    });
    const request = adapter.buildRequest(
      [
        {
          role: "user",
          content: [{ type: "text", text: "list files" }],
          timestamp: 1,
        },
        {
          role: "assistant",
          model: "grok-4",
          content: [
            { type: "text", text: "running tool" },
            { type: "tool_call", id: "call_1", name: "ls", arguments: {} },
          ],
          timestamp: 2,
        },
      ],
      "claude-opus-4",
      {},
    );
    expect(request.body).toContain("tool_result");
    expect(request.body).toContain("call_1");
  });

  it("changes buildRequest bodies after a thinking-only turn for builtin and Corbits adapters", () => {
    const sanitized = withReplaySanitizer(corbitsRegistry());
    const cases: LastCycleSource[] = [
      { sourceId: "s1", provider: "anthropic", model: "claude-opus-4" },
      { sourceId: "s1", provider: "google-genai", model: "gemini-2.5-pro" },
      { sourceId: "s1", provider: "openai", model: "gpt-5" },
      { sourceId: "s1", provider: "openai-compatible", model: "kimi-k2" },
      { sourceId: "s1", provider: "grok-responses", model: "grok-4.5" },
    ];
    for (const source of cases) {
      const adapter = sanitized.resolve(source);
      const without = adapter.buildRequest(USER_ONLY, source.model, {});
      const withThinking = adapter.buildRequest(
        [...USER_ONLY, THINKING_ONLY_TAIL],
        source.model,
        {},
      );
      expect(withThinking.body).not.toEqual(without.body);
      expect(withThinking.body).toContain(THINKING_ONLY_OMITTED);
    }
  });

  it("builds requests for thinking-only and leftover-only assistant turns", () => {
    const adapter = resolveSanitized({
      sourceId: "s1",
      provider: "anthropic",
      model: "claude-opus-4",
    });
    const leftoverHistory: ConversationTurn[] = [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
        timestamp: 1,
      },
      {
        role: "assistant",
        model: "grok-4",
        content: [
          { type: "thinking", thinking: "pondering" },
          { type: "redacted_thinking", data: "opaque" },
          { type: "citation", citedText: "quote", source: {} },
        ],
        timestamp: 2,
      },
    ];
    expect(() => adapter.buildRequest(thinkingOnlyHistory(), "claude-opus-4", {})).not.toThrow();
    expect(() => adapter.buildRequest(leftoverHistory, "claude-opus-4", {})).not.toThrow();
  });
});
