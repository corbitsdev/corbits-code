import { describe, test, expect } from "bun:test";
import {
  createPruningCompactor,
  buildContextEnvelope,
  formatPlan,
  classifyTaskBoundary,
  buildLLMTurnSummary,
  type SessionMetadata,
} from "./session/compactor.js";
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

// Every text block across every turn, so assertions can check that content
// survives compaction without depending on how turns are merged.
function allText(turns: ConversationTurn[]): string {
  return turns
    .flatMap((t) => t.content.filter((b) => b.type === "text").map((b) => b.text))
    .join("\n");
}

function hasConsecutiveSameRole(turns: ConversationTurn[]): boolean {
  return turns.some((t, i) => i > 0 && turns[i - 1]!.role === t.role);
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

    // Summary leads as a user turn (survives every adapter).
    expect(result.output[0]!.role).toBe("user");
    expect(allText(result.output)).toContain("[Compacted prior context]");
    // The initiating user message and the recent turn both survive.
    expect(allText(result.output)).toContain("old message 1");
    expect(allText(result.output)).toContain("recent response");
    // Compaction never emits a non-alternating role sequence.
    expect(hasConsecutiveSameRole(result.output)).toBe(false);
  });

  test("handles empty turn list", async () => {
    const compactor = createPruningCompactor();
    const result = await compactor.apply([], mockStrategyCtx);
    expect(result.output).toEqual([]);
  });

  test("preserves tool_call and tool_result blocks in recent turns", async () => {
    const compactor = createPruningCompactor({ keepRecentTurns: 1, summaryMaxChars: 500 });
    const turns: ConversationTurn[] = [
      makeTurn({ role: "assistant", content: [{ type: "text", text: "old" }] }),
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

describe("createPruningCompactor — initiating task preservation", () => {
  test("keeps the initiating task verbatim even when it is far outside the recent window", async () => {
    const compactor = createPruningCompactor({ keepRecentTurns: 2, maxAnchorTurns: 1, summaryMaxChars: 500 });
    const goal = "GOAL: migrate the auth module to opaque tokens";
    const turns: ConversationTurn[] = [
      makeTurn({ role: "user", content: [{ type: "text", text: goal }] }),
    ];
    for (let i = 0; i < 8; i++) {
      turns.push(makeTurn({ role: "assistant", content: [{ type: "text", text: `step ${i}` }] }));
    }
    // A later user turn would win the single anchor slot on recency alone;
    // the initiating task must still survive.
    turns.push(makeTurn({ role: "user", content: [{ type: "text", text: "also handle refresh" }] }));
    turns.push(makeTurn({ role: "assistant", content: [{ type: "text", text: "recent reply" }] }));
    turns.push(makeTurn({ role: "user", content: [{ type: "text", text: "recent ask" }] }));

    const result = await compactor.apply(turns, mockStrategyCtx);

    const preservedVerbatim = result.output.some(
      (t) => t.role === "user" && t.content.some((b) => b.type === "text" && b.text === goal),
    );
    expect(preservedVerbatim).toBe(true);
  });

  test("emits the compaction summary as a user turn, never system", async () => {
    const compactor = createPruningCompactor({ keepRecentTurns: 1, summaryMaxChars: 500 });
    const turns: ConversationTurn[] = [
      makeTurn({ role: "assistant", content: [{ type: "text", text: "a" }] }),
      makeTurn({ role: "assistant", content: [{ type: "text", text: "b" }] }),
      makeTurn({ role: "user", content: [{ type: "text", text: "recent" }] }),
    ];
    const result = await compactor.apply(turns, mockStrategyCtx);
    expect(result.output[0]!.role).toBe("user");
    expect(result.output.every((t) => t.role !== "system")).toBe(true);
  });

  test("never emits consecutive same-role turns, even with adjacent user anchors", async () => {
    const compactor = createPruningCompactor({ keepRecentTurns: 2, summaryMaxChars: 500 });
    const turns: ConversationTurn[] = [
      makeTurn({ role: "user", content: [{ type: "text", text: "the initiating task" }] }),
      makeTurn({ role: "assistant", content: [{ type: "text", text: "a" }] }),
      makeTurn({ role: "assistant", content: [{ type: "text", text: "b" }] }),
      makeTurn({ role: "user", content: [{ type: "text", text: "a follow-up ask" }] }),
      makeTurn({ role: "assistant", content: [{ type: "text", text: "c" }] }),
    ];
    const result = await compactor.apply(turns, mockStrategyCtx);
    expect(hasConsecutiveSameRole(result.output)).toBe(false);
    expect(allText(result.output)).toContain("the initiating task");
  });

  test("keeps alternating roles when a tool_result user turn abuts a plain user turn", async () => {
    const compactor = createPruningCompactor({ keepRecentTurns: 1, maxAnchorTurns: 3, summaryMaxChars: 500 });
    const turns: ConversationTurn[] = [
      makeTurn({ role: "user", content: [{ type: "text", text: "the initiating task" }] }),
      makeTurn({ role: "assistant", content: [{ type: "tool_call", id: "c1", name: "edit_file", arguments: { path: "src/a.ts" } }] }),
      makeTurn({ role: "user", content: [{ type: "tool_result", callId: "c1", content: [{ type: "text", text: "edited" }] }] }),
      makeTurn({ role: "assistant", content: [{ type: "text", text: "reasoning that gets summarized" }] }),
      makeTurn({ role: "user", content: [{ type: "text", text: "the recent ask" }] }),
    ];
    const result = await compactor.apply(turns, mockStrategyCtx);
    // The summarized assistant turn would leave the tool_result user turn next
    // to the recent user turn; coalescing must still alternate.
    expect(hasConsecutiveSameRole(result.output)).toBe(false);
    // The tool_result stays paired with its tool_call.
    const callTurnIdx = result.output.findIndex((t) => t.content.some((b) => b.type === "tool_call" && b.id === "c1"));
    const resultTurn = result.output[callTurnIdx + 1];
    expect(resultTurn?.content.some((b) => b.type === "tool_result" && b.callId === "c1")).toBe(true);
  });
});

describe("createPruningCompactor — image aging", () => {
  const imageBlock = { type: "image" as const, source: { kind: "base64" as const, mimeType: "image/png", data: "iVBORw0KGgo=" } };

  test("strips image bytes from an anchored (aged) turn but keeps its text", async () => {
    const compactor = createPruningCompactor({ keepRecentTurns: 2, maxAnchorTurns: 1, summaryMaxChars: 500 });
    const turns: ConversationTurn[] = [
      makeTurn({
        role: "user",
        content: [
          { type: "text", text: "here's a screenshot of the bug" },
          imageBlock,
        ],
      }),
    ];
    for (let i = 0; i < 8; i++) {
      turns.push(makeTurn({ role: "assistant", content: [{ type: "text", text: `step ${i}` }] }));
    }
    turns.push(makeTurn({ role: "user", content: [{ type: "text", text: "recent ask" }] }));
    turns.push(makeTurn({ role: "assistant", content: [{ type: "text", text: "recent reply" }] }));

    const result = await compactor.apply(turns, mockStrategyCtx);

    // The full base64 payload must not appear anywhere in the materialized output.
    expect(JSON.stringify(result.output)).not.toContain("iVBORw0KGgo=");
    expect(result.output.some((t) => t.content.some((b) => b.type === "image"))).toBe(false);
    // The turn's text content, and the fact an image was there, still survive.
    const initiatingTurn = result.output.find((t) =>
      t.content.some((b) => b.type === "text" && b.text === "here's a screenshot of the bug"),
    );
    expect(initiatingTurn).toBeDefined();
    expect(initiatingTurn?.content.some((b) => b.type === "text" && b.text.includes("shown"))).toBe(true);
  });

  test("keeps an image intact when its turn is still within the recent window", async () => {
    const compactor = createPruningCompactor({ keepRecentTurns: 3, summaryMaxChars: 500 });
    const turns: ConversationTurn[] = [
      makeTurn({ role: "user", content: [{ type: "text", text: "old 1" }] }),
      makeTurn({ role: "assistant", content: [{ type: "text", text: "old 2" }] }),
      makeTurn({ role: "user", content: [{ type: "text", text: "here's a screenshot" }, imageBlock] }),
      makeTurn({ role: "assistant", content: [{ type: "text", text: "looking at it" }] }),
      makeTurn({ role: "user", content: [{ type: "text", text: "recent ask" }] }),
    ];

    const result = await compactor.apply(turns, mockStrategyCtx);

    expect(JSON.stringify(result.output)).toContain("iVBORw0KGgo=");
  });

  test("records the number of turns aged out in the transform record", async () => {
    const compactor = createPruningCompactor({ keepRecentTurns: 1, maxAnchorTurns: 1, summaryMaxChars: 500 });
    const turns: ConversationTurn[] = [
      makeTurn({ role: "user", content: [{ type: "text", text: "task" }, imageBlock] }),
      ...Array.from({ length: 6 }, (_, i) =>
        makeTurn({ role: i % 2 === 0 ? "assistant" : "user", content: [{ type: "text", text: `t${i}` }] }),
      ),
    ];
    const result = await compactor.apply(turns, mockStrategyCtx);
    expect(result.record.decisions["agedImageCount"]).toBeGreaterThanOrEqual(1);
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
        role: "user",
        content: [
          { type: "tool_result", callId: "c1", content: [{ type: "text", text: "file contents here" }] },
        ],
      }),
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
