import { describe, expect, test } from "bun:test";
import type {
  ContentBlock,
  ConversationTurn,
  MediaSource,
  ToolDefinition,
} from "@intx/types/runtime";
import {
  createContextEstimate,
  estimateContentBlockTokens,
  estimateContextTokens,
  estimateMediaSourceTokens,
  estimateOverheadTokens,
  estimateTokensFromChars,
} from "./context-estimate.js";

function textTurn(text: string, role: "user" | "assistant" = "user"): ConversationTurn {
  return {
    role,
    content: [{ type: "text", text }],
    timestamp: 0,
  } as unknown as ConversationTurn;
}

describe("estimateTokensFromChars", () => {
  test("ceil-divides by 4 and floors at zero", () => {
    expect(estimateTokensFromChars(0)).toBe(0);
    expect(estimateTokensFromChars(-1)).toBe(0);
    expect(estimateTokensFromChars(1)).toBe(1);
    expect(estimateTokensFromChars(4)).toBe(1);
    expect(estimateTokensFromChars(5)).toBe(2);
  });
});

describe("estimateMediaSourceTokens", () => {
  test("counts base64 payload chars and floors external references", () => {
    const base64: MediaSource = { kind: "base64", data: "abcd".repeat(100), mimeType: "image/png" };
    expect(estimateMediaSourceTokens(base64)).toBe(estimateTokensFromChars(400));

    const url: MediaSource = {
      kind: "url",
      url: "https://example.com/a.png",
      mimeType: "image/png",
    };
    expect(estimateMediaSourceTokens(url)).toBe(1_000);
  });

  test("caps large base64 payloads at a vision-tile ballpark", () => {
    // ~1MB of base64 would be ~250k tokens uncapped; providers bill tiles not bytes.
    const huge: MediaSource = {
      kind: "base64",
      data: "a".repeat(1_000_000),
      mimeType: "image/png",
    };
    expect(estimateMediaSourceTokens(huge)).toBe(2_500);
    expect(estimateMediaSourceTokens(huge)).toBeLessThan(estimateTokensFromChars(1_000_000));
  });
});

describe("estimateContentBlockTokens", () => {
  test("covers text, tools, media, and nested tool results", () => {
    const text: ContentBlock = { type: "text", text: "hello world" };
    expect(estimateContentBlockTokens(text)).toBe(estimateTokensFromChars(11));

    const toolCall: ContentBlock = {
      type: "tool_call",
      id: "c1",
      name: "run_shell",
      arguments: { command: "ls" },
    } as ContentBlock;
    expect(estimateContentBlockTokens(toolCall)).toBe(
      estimateTokensFromChars("run_shell".length + JSON.stringify({ command: "ls" }).length),
    );

    const toolResult: ContentBlock = {
      type: "tool_result",
      callId: "c1",
      content: [{ type: "text", text: "ok" }],
    } as ContentBlock;
    expect(estimateContentBlockTokens(toolResult)).toBe(estimateTokensFromChars(2));

    const image: ContentBlock = {
      type: "image",
      source: { kind: "url", url: "https://example.com/a.png" },
    } as ContentBlock;
    expect(estimateContentBlockTokens(image)).toBe(1_000);
  });
});

describe("estimateContextTokens", () => {
  test("sums content across every turn", () => {
    const turns = [textTurn("aaaa"), textTurn("bbbbbbbb", "assistant")];
    // 4 + 8 chars → 1 + 2 tokens
    expect(estimateContextTokens(turns)).toBe(3);
  });
});

describe("estimateOverheadTokens", () => {
  test("counts the system prompt and every tool's name, description, and schema", () => {
    const systemPrompt = "x".repeat(40);
    const tools: ToolDefinition[] = [
      { name: "run_shell", description: "y".repeat(20), inputSchema: { command: "string" } },
    ];
    const expectedChars =
      40 + "run_shell".length + 20 + JSON.stringify({ command: "string" }).length;
    expect(estimateOverheadTokens(systemPrompt, tools)).toBe(
      estimateTokensFromChars(expectedChars),
    );
  });

  test("is zero for an empty prompt and no tools", () => {
    expect(estimateOverheadTokens("", [])).toBe(0);
  });
});

describe("createContextEstimate", () => {
  test("folds a fixed overhead into every sync", () => {
    const estimate = createContextEstimate(100);
    expect(estimate.tokens).toBe(100);
    expect(estimate.syncFromTurns([textTurn("xxxx")])).toBe(101);
    expect(estimate.tokens).toBe(101);
  });

  test("re-syncs from the full turn list after each append", () => {
    const estimate = createContextEstimate();
    expect(estimate.tokens).toBe(0);
    expect(estimate.turnCount).toBe(0);

    const first = [textTurn("xxxx")];
    expect(estimate.syncFromTurns(first)).toBe(1);
    expect(estimate.tokens).toBe(1);
    expect(estimate.turnCount).toBe(1);

    // Tool-result growth: re-sync replaces, does not add.
    const withTool = [
      textTurn("xxxx"),
      {
        role: "assistant",
        content: [
          {
            type: "tool_result",
            callId: "c1",
            content: [{ type: "text", text: "y".repeat(40) }],
          },
        ],
        timestamp: 1,
      } as unknown as ConversationTurn,
    ];
    expect(estimate.syncFromTurns(withTool)).toBe(1 + 10);
    expect(estimate.tokens).toBe(11);
    expect(estimate.turnCount).toBe(2);

    // Compaction rewrite shrinks the estimate.
    expect(estimate.syncFromTurns([textTurn("zz")])).toBe(1);
    expect(estimate.tokens).toBe(1);
    expect(estimate.turnCount).toBe(1);
  });
});
