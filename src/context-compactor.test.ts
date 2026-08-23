import { describe, test, expect } from "bun:test";
import {
  createPruningCompactor,
  compactorNoOpFloor,
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

function makeTurn(
  overrides: Partial<ConversationTurn> & { role: ConversationTurn["role"] },
): ConversationTurn {
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

  test("compactorNoOpFloor names the exact turn count apply() no-ops on", async () => {
    // The compaction governor (agent/compaction.ts) derives its arming floor
    // from this function so it never arms a compaction guaranteed to no-op.
    // Anyone changing apply()'s no-op condition without updating
    // compactorNoOpFloor accordingly breaks that guarantee silently.
    const keepRecentTurns = 3;
    const compactor = createPruningCompactor({ keepRecentTurns, summaryMaxChars: 500 });
    const floor = compactorNoOpFloor(keepRecentTurns);

    const atFloor = Array.from({ length: floor }, (_, i) =>
      makeTurn({ role: i % 2 === 0 ? "user" : "assistant" }),
    );
    const pastFloor = Array.from({ length: floor + 1 }, (_, i) =>
      makeTurn({ role: i % 2 === 0 ? "user" : "assistant" }),
    );

    expect((await compactor.apply(atFloor, mockStrategyCtx)).record.reason).toBe(
      "no compaction needed",
    );
    expect((await compactor.apply(pastFloor, mockStrategyCtx)).record.reason).not.toBe(
      "no compaction needed",
    );
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
    const compactor = createPruningCompactor({
      keepRecentTurns: 2,
      maxAnchorTurns: 1,
      summaryMaxChars: 500,
    });
    const goal = "GOAL: migrate the auth module to opaque tokens";
    const turns: ConversationTurn[] = [
      makeTurn({ role: "user", content: [{ type: "text", text: goal }] }),
    ];
    for (let i = 0; i < 8; i++) {
      turns.push(makeTurn({ role: "assistant", content: [{ type: "text", text: `step ${i}` }] }));
    }
    // A later user turn would win the single anchor slot on recency alone;
    // the initiating task must still survive.
    turns.push(
      makeTurn({ role: "user", content: [{ type: "text", text: "also handle refresh" }] }),
    );
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
    const compactor = createPruningCompactor({
      keepRecentTurns: 1,
      maxAnchorTurns: 3,
      summaryMaxChars: 500,
    });
    const turns: ConversationTurn[] = [
      makeTurn({ role: "user", content: [{ type: "text", text: "the initiating task" }] }),
      makeTurn({
        role: "assistant",
        content: [
          { type: "tool_call", id: "c1", name: "edit_file", arguments: { path: "src/a.ts" } },
        ],
      }),
      makeTurn({
        role: "user",
        content: [
          { type: "tool_result", callId: "c1", content: [{ type: "text", text: "edited" }] },
        ],
      }),
      makeTurn({
        role: "assistant",
        content: [{ type: "text", text: "reasoning that gets summarized" }],
      }),
      makeTurn({ role: "user", content: [{ type: "text", text: "the recent ask" }] }),
    ];
    const result = await compactor.apply(turns, mockStrategyCtx);
    // The summarized assistant turn would leave the tool_result user turn next
    // to the recent user turn; coalescing must still alternate.
    expect(hasConsecutiveSameRole(result.output)).toBe(false);
    // The tool_result stays paired with its tool_call.
    const callTurnIdx = result.output.findIndex((t) =>
      t.content.some((b) => b.type === "tool_call" && b.id === "c1"),
    );
    const resultTurn = result.output[callTurnIdx + 1];
    expect(resultTurn?.content.some((b) => b.type === "tool_result" && b.callId === "c1")).toBe(
      true,
    );
  });
});

describe("createPruningCompactor — image aging", () => {
  const imageBlock = {
    type: "image" as const,
    source: { kind: "base64" as const, mimeType: "image/png", data: "iVBORw0KGgo=" },
  };

  test("strips image bytes from an anchored (aged) turn but keeps its text", async () => {
    const compactor = createPruningCompactor({
      keepRecentTurns: 2,
      maxAnchorTurns: 1,
      summaryMaxChars: 500,
    });
    const turns: ConversationTurn[] = [
      makeTurn({
        role: "user",
        content: [{ type: "text", text: "here's a screenshot of the bug" }, imageBlock],
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
    // The turn's text content, and a rehydratable attachment URI, still survive.
    const initiatingTurn = result.output.find((t) =>
      t.content.some((b) => b.type === "text" && b.text === "here's a screenshot of the bug"),
    );
    expect(initiatingTurn).toBeDefined();
    expect(
      initiatingTurn?.content.some(
        (b) => b.type === "text" && b.text.includes("attachment:///") && b.text.includes("aged"),
      ),
    ).toBe(true);
    expect(result.blobs).toBeDefined();
    expect(result.blobs!.length).toBeGreaterThanOrEqual(1);
    expect(result.blobs![0]!.contentType).toBe("image/png");
    // Blob payload is the original base64 (UTF-8), not lost.
    expect(new TextDecoder().decode(result.blobs![0]!.bytes)).toBe("iVBORw0KGgo=");
  });

  test("keeps an image intact when its turn is still within the recent window", async () => {
    const compactor = createPruningCompactor({ keepRecentTurns: 3, summaryMaxChars: 500 });
    const turns: ConversationTurn[] = [
      makeTurn({ role: "user", content: [{ type: "text", text: "old 1" }] }),
      makeTurn({ role: "assistant", content: [{ type: "text", text: "old 2" }] }),
      makeTurn({
        role: "user",
        content: [{ type: "text", text: "here's a screenshot" }, imageBlock],
      }),
      makeTurn({ role: "assistant", content: [{ type: "text", text: "looking at it" }] }),
      makeTurn({ role: "user", content: [{ type: "text", text: "recent ask" }] }),
    ];

    const result = await compactor.apply(turns, mockStrategyCtx);

    expect(JSON.stringify(result.output)).toContain("iVBORw0KGgo=");
  });

  test("ages images outside the keep window even when total length is under the compact threshold", async () => {
    // With few turns, full pruning is a no-op, but images outside keepRecentTurns
    // must still spill so they are not resent as base64 forever.
    const compactor = createPruningCompactor({ keepRecentTurns: 2, summaryMaxChars: 500 });
    const turns: ConversationTurn[] = [
      makeTurn({
        role: "user",
        content: [{ type: "text", text: "old screenshot" }, imageBlock],
      }),
      makeTurn({ role: "assistant", content: [{ type: "text", text: "noted" }] }),
      makeTurn({ role: "user", content: [{ type: "text", text: "recent ask" }] }),
      makeTurn({ role: "assistant", content: [{ type: "text", text: "recent reply" }] }),
    ];

    const result = await compactor.apply(turns, mockStrategyCtx);

    expect(JSON.stringify(result.output)).not.toContain("iVBORw0KGgo=");
    expect(result.blobs).toBeDefined();
    expect(result.blobs!.length).toBeGreaterThanOrEqual(1);
    expect(
      result.output.some((t) =>
        t.content.some(
          (b) => b.type === "text" && b.text.includes("attachment:///") && b.text.includes("aged"),
        ),
      ),
    ).toBe(true);
  });

  test("records the number of turns aged out in the transform record", async () => {
    const compactor = createPruningCompactor({
      keepRecentTurns: 1,
      maxAnchorTurns: 1,
      summaryMaxChars: 500,
    });
    const turns: ConversationTurn[] = [
      makeTurn({ role: "user", content: [{ type: "text", text: "task" }, imageBlock] }),
      ...Array.from({ length: 6 }, (_, i) =>
        makeTurn({
          role: i % 2 === 0 ? "assistant" : "user",
          content: [{ type: "text", text: `t${i}` }],
        }),
      ),
    ];
    const result = await compactor.apply(turns, mockStrategyCtx);
    expect(result.record.decisions["agedImageCount"]).toBeGreaterThanOrEqual(1);
  });
});

describe("createPruningCompactor — error anchoring (CL-6906)", () => {
  function assistantErrorCall(id: string, name: string): ConversationTurn {
    return makeTurn({
      role: "assistant",
      content: [{ type: "tool_call", id, name, arguments: {} }],
    });
  }
  function errorResult(callId: string, text: string): ConversationTurn {
    return makeTurn({
      role: "user",
      content: [{ type: "tool_result", callId, content: [{ type: "text", text }], isError: true }],
    });
  }
  function padding(n: number, prefix: string): ConversationTurn[] {
    return Array.from({ length: n }, (_, i) =>
      makeTurn({
        role: i % 2 === 0 ? "assistant" : "user",
        content: [{ type: "text", text: `${prefix}${i}` }],
      }),
    );
  }

  test("a lone errored tool_result no longer anchors on its own", async () => {
    const turns: ConversationTurn[] = [
      makeTurn({ role: "user", content: [{ type: "text", text: "the initiating task" }] }),
      ...padding(3, "before"),
      assistantErrorCall("e1", "run_shell"),
      errorResult("e1", "Error: exit code 1 " + "x".repeat(100)),
      ...padding(8, "after"),
    ];
    const compactor = createPruningCompactor({
      keepRecentTurns: 6,
      maxAnchorTurns: 8,
      summaryMaxChars: 2000,
    });
    const { output } = await compactor.apply(turns, mockStrategyCtx);
    // The lone error's own turn score (3) sits below the anchor threshold (5),
    // so its body must not survive verbatim outside the recent window.
    const survivedVerbatim = output.some((t) =>
      t.content.some((b) => b.type === "tool_result" && b.callId === "e1"),
    );
    expect(survivedVerbatim).toBe(false);
  });

  test("two distinct errors on one turn still clear the anchor threshold", async () => {
    const turns: ConversationTurn[] = [
      makeTurn({ role: "user", content: [{ type: "text", text: "the initiating task" }] }),
      ...padding(3, "before"),
      makeTurn({
        role: "assistant",
        content: [
          { type: "tool_call", id: "d1", name: "run_shell", arguments: {} },
          { type: "tool_call", id: "d2", name: "grep", arguments: {} },
        ],
      }),
      makeTurn({
        role: "user",
        content: [
          {
            type: "tool_result",
            callId: "d1",
            content: [{ type: "text", text: "Error: build failed" }],
            isError: true,
          },
          {
            type: "tool_result",
            callId: "d2",
            content: [{ type: "text", text: "Error: no matches found" }],
            isError: true,
          },
        ],
      }),
      ...padding(8, "after"),
    ];
    const compactor = createPruningCompactor({
      keepRecentTurns: 6,
      maxAnchorTurns: 8,
      summaryMaxChars: 2000,
    });
    const { output } = await compactor.apply(turns, mockStrategyCtx);
    const kept = output.find((t) =>
      t.content.some((b) => b.type === "tool_result" && b.callId === "d1"),
    );
    expect(kept).toBeDefined();
    expect(kept?.content.some((b) => b.type === "tool_result" && b.callId === "d2")).toBe(true);
  });

  test("repeated identical errors collapse to one representative before anchor selection", async () => {
    // "old" repeats the same (tool, error-text) signature that recurs again
    // later ("recur"); combined with a distinct error on the same turn, the
    // uncollapsed score (3 + 3 = 6) would clear the threshold, but the
    // collapsed score (0 + 3 = 3) must not.
    const sharedErrorText = "Error: type mismatch on line 12, expected string";
    const turns: ConversationTurn[] = [
      makeTurn({ role: "user", content: [{ type: "text", text: "the initiating task" }] }),
      ...padding(3, "before"),
      makeTurn({
        role: "assistant",
        content: [
          { type: "tool_call", id: "old", name: "edit_file_check", arguments: {} },
          { type: "tool_call", id: "uniq", name: "grep", arguments: {} },
        ],
      }),
      makeTurn({
        role: "user",
        content: [
          {
            type: "tool_result",
            callId: "old",
            content: [{ type: "text", text: sharedErrorText }],
            isError: true,
          },
          {
            type: "tool_result",
            callId: "uniq",
            content: [{ type: "text", text: "Error: distinct failure here" }],
            isError: true,
          },
        ],
      }),
      ...padding(4, "mid"),
      assistantErrorCall("recur", "edit_file_check"),
      errorResult("recur", sharedErrorText),
      ...padding(8, "after"),
    ];
    const compactor = createPruningCompactor({
      keepRecentTurns: 6,
      maxAnchorTurns: 8,
      summaryMaxChars: 2000,
    });
    const { output, record } = await compactor.apply(turns, mockStrategyCtx);
    expect(record.decisions["repeatedErrorCount"]).toBe(1);
    // The combined turn's score drops below threshold once "old" is
    // collapsed, so neither of its results survives verbatim.
    const oldSurvived = output.some((t) =>
      t.content.some((b) => b.type === "tool_result" && b.callId === "old"),
    );
    const uniqSurvived = output.some((t) =>
      t.content.some((b) => b.type === "tool_result" && b.callId === "uniq"),
    );
    expect(oldSurvived).toBe(false);
    expect(uniqSurvived).toBe(false);
  });
});

describe("createPruningCompactor — maxAnchorTurns caps pairing pulls (CL-6906)", () => {
  test("bounds the total scored-anchor pull even when many high-score pairs are scattered through history", async () => {
    const turns: ConversationTurn[] = [
      makeTurn({ role: "user", content: [{ type: "text", text: "the initiating task" }] }),
    ];
    // 10 edit_file call/result pairs, well separated from each other and from
    // the recent window, each independently clearing the anchor threshold.
    for (let i = 0; i < 10; i++) {
      turns.push(
        makeTurn({
          role: "assistant",
          content: [
            {
              type: "tool_call",
              id: `edit${i}`,
              name: "edit_file",
              arguments: { path: `f${i}.ts` },
            },
          ],
        }),
        makeTurn({
          role: "user",
          content: [
            {
              type: "tool_result",
              callId: `edit${i}`,
              content: [{ type: "text", text: `edited f${i}.ts` }],
            },
          ],
        }),
        makeTurn({ role: "assistant", content: [{ type: "text", text: `note ${i}` }] }),
        makeTurn({ role: "user", content: [{ type: "text", text: `ask ${i}` }] }),
      );
    }
    for (let i = 0; i < 6; i++) {
      turns.push(
        makeTurn({
          role: i % 2 === 0 ? "assistant" : "user",
          content: [{ type: "text", text: `recent${i}` }],
        }),
      );
    }

    const maxAnchorTurns = 4;
    const compactor = createPruningCompactor({
      keepRecentTurns: 6,
      maxAnchorTurns,
      summaryMaxChars: 2000,
    });
    const { record } = await compactor.apply(turns, mockStrategyCtx);
    // The initiating task (1 turn, no partners) is kept outside the cap; the
    // scored/pair-partner pull must stay within maxAnchorTurns.
    const anchorTurnCount = record.decisions["anchorTurnCount"] as number;
    expect(anchorTurnCount - 1).toBeLessThanOrEqual(maxAnchorTurns);
    // With a budget of 4 and each edit pair costing 2 (call + result), exactly
    // two pairs (the most recent two) fit; a third would overshoot and must
    // be rejected as a whole, not split.
    expect(anchorTurnCount).toBe(1 + 4);
  });
});

describe("createPruningCompactor — summarize receives the workflow context (CL-6906)", () => {
  test("passes cfg.summaryContext() through to summarize as the second argument", async () => {
    let capturedCtx: unknown = "not called";
    const workflowCtx = { workflow: { name: "build", stepIndex: 2, total: 7 } };
    const compactor = createPruningCompactor({
      keepRecentTurns: 1,
      summaryMaxChars: 500,
      summaryContext: () => workflowCtx,
      summarize: async (_turns, ctx) => {
        capturedCtx = ctx;
        return "summary text";
      },
    });
    const turns: ConversationTurn[] = [
      makeTurn({ role: "assistant", content: [{ type: "text", text: "a" }] }),
      makeTurn({ role: "assistant", content: [{ type: "text", text: "b" }] }),
      makeTurn({ role: "user", content: [{ type: "text", text: "recent" }] }),
    ];
    await compactor.apply(turns, mockStrategyCtx);
    expect(capturedCtx).toBe(workflowCtx);
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
    expect(result).toBe(
      "1. src/foo.ts — edit (Fix the bug)\n2. src/bar.ts — read (Verify the fix)",
    );
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
          {
            type: "tool_result",
            callId: "c1",
            content: [{ type: "text", text: "file contents here" }],
          },
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
