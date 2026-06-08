import { describe, test, expect } from "bun:test";
import {
  createPruningCompactor,
  buildContextEnvelope,
  formatPlan,
  classifyTaskBoundary,
  buildLLMTurnSummary,
  type SessionMetadata,
} from "./context-compactor.js";
import type { ConversationTurn, StrategyContext } from "@intx/types/runtime";

const mockStrategyCtx: StrategyContext = {
  state: {} as any,
  trigger: "test",
};

function makeTurn(overrides: Partial<ConversationTurn> & { role: ConversationTurn["role"] }): ConversationTurn {
  return {
    content: [{ type: "text", text: "" }],
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("createPruningCompactor", () => {
  test("returns turns unchanged when under the keep threshold", async () => {
    const compactor = createPruningCompactor({ keepRecentTurns: 5, summaryMaxChars: 500 });
    const turns: ConversationTurn[] = [
      makeTurn({ role: "user" }),
      makeTurn({ role: "assistant" }),
      makeTurn({ role: "user" }),
    ];
    const result = await compactor.apply(turns, mockStrategyCtx);
    expect(result.output).toBe(turns); // Same reference when no compaction needed
  });

  test("compacts old turns and preserves recent ones", async () => {
    const compactor = createPruningCompactor({ keepRecentTurns: 2, summaryMaxChars: 500 });
    const turns: ConversationTurn[] = [
      makeTurn({ role: "user", content: [{ type: "text", text: "old message 1" }] }),
      makeTurn({ role: "assistant", content: [{ type: "text", text: "old response 1" }] }),
      makeTurn({ role: "user", content: [{ type: "text", text: "old message 2" }] }),
      makeTurn({ role: "assistant", content: [{ type: "text", text: "old response 2" }] }),
      makeTurn({ role: "user", content: [{ type: "text", text: "recent message" }] }),
      makeTurn({ role: "assistant", content: [{ type: "text", text: "recent response" }] }),
    ];

    const result = await compactor.apply(turns, mockStrategyCtx);

    // Should have 3 turns: the summary + 2 recent
    expect(result.output.length).toBe(3);
    expect(result.output[0]!.role).toBe("system");
    expect(result.output[0]!.content[0]!.type).toBe("text");
    expect((result.output[0]!.content[0]! as { text: string }).text).toContain("[Compacted prior context]");
    // Recent turns preserved in full
    expect(result.output[1]!.role).toBe("user");
    expect((result.output[1]!.content[0]! as { text: string }).text).toBe("recent message");
    expect(result.output[2]!.role).toBe("assistant");
    expect((result.output[2]!.content[0]! as { text: string }).text).toBe("recent response");
  });

  test("handles empty turn list", async () => {
    const compactor = createPruningCompactor();
    const result = await compactor.apply([], mockStrategyCtx);
    expect(result.output).toEqual([]);
  });

  test("preserves tool_call and tool_result blocks in recent turns", async () => {
    const compactor = createPruningCompactor({ keepRecentTurns: 1, summaryMaxChars: 500 });
    const turns: ConversationTurn[] = [
      makeTurn({ role: "user", content: [{ type: "text", text: "old" }] }),
      makeTurn({
        role: "assistant",
        content: [
          { type: "text", text: "recent reply" },
          { type: "tool_call", id: "c1", name: "read_file", arguments: { path: "src/foo.ts" } },
        ],
      }),
    ];

    const result = await compactor.apply(turns, mockStrategyCtx);

    expect(result.output.length).toBe(2);
    const recentTurn = result.output[1]!;
    expect(recentTurn.role).toBe("assistant");
    const toolCalls = recentTurn.content.filter((b) => b.type === "tool_call");
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0]!.name).toBe("read_file");
  });
});

describe("buildContextEnvelope", () => {
  test("includes active task label", () => {
    const result = buildContextEnvelope({
      activeTask: "Fix login bug",
      recentTurns: 5,
    });
    expect(result).toContain("Active task: Fix login bug");
  });

  test("includes prior task summary", () => {
    const result = buildContextEnvelope({
      taskSummary: "Refactored the auth module",
      recentTurns: 3,
    });
    expect(result).toContain("Prior task summary:");
    expect(result).toContain("Refactored the auth module");
  });

  test("includes file references", () => {
    const result = buildContextEnvelope({
      fileReferences: ["src/auth.ts", "src/config.ts"],
      recentTurns: 5,
    });
    expect(result).toContain("Files referenced: src/auth.ts, src/config.ts");
  });

  test("handles minimal envelope", () => {
    const result = buildContextEnvelope({ recentTurns: 5 });
    expect(result).toContain("Recent turns shown: 5");
    expect(result).toContain("--- Context ---");
    expect(result).toContain("---");
  });

  test("includes unresolved errors", () => {
    const result = buildContextEnvelope({
      recentTurns: 5,
      unresolvedErrors: ["TypeError: Cannot read properties of undefined"],
    });
    expect(result).toContain("Unresolved errors:");
  });
});

describe("formatPlan", () => {
  test("formats plan steps", () => {
    const steps = [
      { file: "src/foo.ts", action: "edit", reason: "Fix the bug" },
      { file: "src/bar.ts", action: "read", reason: "Verify the fix" },
    ];
    const result = formatPlan(steps);
    expect(result).toBe("1. src/foo.ts — edit (Fix the bug)\n2. src/bar.ts — read (Verify the fix)");
  });
});

describe("classifyTaskBoundary", () => {
  const metadata: SessionMetadata = {
    turnCount: 5,
    currentTaskLabel: "Refactor auth",
    lastTaskSummary: undefined as never,
    minutesElapsed: 10,
    toolCallCount: 12,
  };

  test("detects /clear as new_task", async () => {
    const boundary = await classifyTaskBoundary("/clear", metadata, async () => {
      return { decision: "same_task", reason: "should not reach here" };
    });
    expect(boundary.kind).toBe("new_task");
    expect(boundary.reason).toContain("explicit boundary command");
  });

  test("detects /new as new_task", async () => {
    const boundary = await classifyTaskBoundary("/new", metadata, async () => {
      return { decision: "same_task", reason: "should not reach here" };
    });
    expect(boundary.kind).toBe("new_task");
  });

  test("short messages on established task are same_task", async () => {
    const boundary = await classifyTaskBoundary("yes", metadata, async () => {
      return { decision: "same_task", reason: "should not reach here" };
    });
    expect(boundary.kind).toBe("same_task");
  });

  test("very early session returns same_task", async () => {
    const earlyMetadata: SessionMetadata = {
      turnCount: 0,
      currentTaskLabel: undefined,
      lastTaskSummary: undefined,
      minutesElapsed: 0,
      toolCallCount: 0,
    };
    const boundary = await classifyTaskBoundary("Do something", earlyMetadata, async () => {
      return { decision: "same_task", reason: "should not reach here" };
    });
    expect(boundary.kind).toBe("same_task");
  });

  test("falls through to LLM classifier for ambiguous messages", async () => {
    const boundary = await classifyTaskBoundary(
      "Let's start a new project now. Build a CLI tool.",
      metadata,
      async (_prompt) => {
        return { decision: "new_task", reason: "user explicitly pivots" };
      },
    );
    expect(boundary.kind).toBe("new_task");
  });

  test("LLM classifier returning same_task is respected", async () => {
    const boundary = await classifyTaskBoundary(
      "Actually, let's continue the refactoring",
      metadata,
      async (_prompt) => {
        return { decision: "same_task", reason: "still on same topic" };
      },
    );
    expect(boundary.kind).toBe("same_task");
  });

  test("LLM classifier failure falls back to unclear", async () => {
    const boundary = await classifyTaskBoundary(
      "I need to completely pivot to a different project now. Let's build something entirely new.",
      metadata,
      async (_prompt) => {
        throw new Error("LLM unavailable");
      },
    );
    expect(boundary.kind).toBe("unclear");
  });

  test("LLM classifier returning unclear is respected", async () => {
    const boundary = await classifyTaskBoundary(
      "I need to completely pivot to a different project now. Let's build something entirely new.",
      metadata,
      async (_prompt) => {
        return { decision: "unclear", reason: "cannot determine intent" };
      },
    );
    expect(boundary.kind).toBe("unclear");
    expect(boundary.reason).toBe("cannot determine intent");
  });
});

describe("buildLLMTurnSummary", () => {
  const turns: ConversationTurn[] = [
    makeTurn({ role: "user", content: [{ type: "text", text: "Fix the login bug" }] }),
    makeTurn({ role: "assistant", content: [{ type: "text", text: "I will fix it" }] }),
  ];

  test("happy path: summarize is called with the prompt and its return value is used", async () => {
    let capturedPrompt = "";
    const summary = await buildLLMTurnSummary(turns, async (prompt) => {
      capturedPrompt = prompt;
      return "Goal: Fix login bug\nProgress: Applied patch";
    });
    expect(capturedPrompt.length).toBeGreaterThan(0);
    expect(summary).toBe("Goal: Fix login bug\nProgress: Applied patch");
  });

  test("failure path: summarize throws and falls back to deterministic summary", async () => {
    const summary = await buildLLMTurnSummary(turns, async () => {
      throw new Error("LLM unavailable");
    });
    // Deterministic fallback always includes turn count and tool info
    expect(summary).toContain("Turns compacted:");
  });
});

describe("buildTurnSummary via createPruningCompactor", () => {
  test("summarizes tool_call and tool_result blocks in compacted turns", async () => {
    const compactor = createPruningCompactor({ keepRecentTurns: 1, summaryMaxChars: 2000 });
    const turns: ConversationTurn[] = [
      makeTurn({
        role: "assistant",
        content: [
          { type: "tool_call", id: "c1", name: "read_file", arguments: { path: "src/foo.ts" } },
        ],
      }),
      makeTurn({
        role: "tool",
        content: [
          { type: "tool_result", toolCallId: "c1", content: "file contents here" },
        ],
      } as unknown as ConversationTurn),
      makeTurn({ role: "user", content: [{ type: "text", text: "recent" }] }),
    ];

    const result = await compactor.apply(turns, mockStrategyCtx);
    const summaryText = (result.output[0]!.content[0]! as { text: string }).text;
    expect(summaryText).toContain("read_file");
    expect(summaryText).toContain("Total tool calls: 1");
  });

  test("truncates summary when it exceeds maxChars", async () => {
    const maxChars = 20;
    const compactor = createPruningCompactor({ keepRecentTurns: 1, summaryMaxChars: maxChars });
    const turns: ConversationTurn[] = [
      makeTurn({ role: "user", content: [{ type: "text", text: "a".repeat(500) }] }),
      makeTurn({ role: "assistant", content: [{ type: "text", text: "b".repeat(500) }] }),
      makeTurn({ role: "user", content: [{ type: "text", text: "recent" }] }),
    ];

    const result = await compactor.apply(turns, mockStrategyCtx);
    const summaryBlock = result.output[0]!.content[0]! as { text: string };
    // The summary portion of the block is extracted from after the header line.
    // The header itself is "---..." so we look at the full block text — the
    // embedded buildTurnSummary output must end with "..." when truncated.
    expect(summaryBlock.text).toContain("...");
    // And the truncated summary must not exceed maxChars + 3 (for the "..." suffix)
    const summaryStart = summaryBlock.text.indexOf("[Compacted prior context]");
    const rawSummary = summaryBlock.text.slice(summaryStart);
    // The raw summary lines are bounded by maxChars
    expect(rawSummary.length).toBeLessThan(maxChars + 200); // header text + bounded summary
  });
});
