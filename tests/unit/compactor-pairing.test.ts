import { describe, expect, test } from "bun:test";
import type { ConversationTurn } from "@intx/types/runtime";
import { createPruningCompactor, buildTurnSummary } from "../../src/session/compactor.js";
import { assertWellFormedToolSequence } from "../../interchange/packages/inference/src/turns.js";

// The runtime puts a tool_call on an assistant turn and its tool_result on the
// FOLLOWING user turn, so the two halves of a pair can land on opposite sides of
// the compaction boundary. The compactor must keep pairs together; otherwise the
// inference layer rejects the compacted prompt (dangling call / orphan result).
function assistantCall(id: string, name = "read_file"): ConversationTurn {
  return { role: "assistant", content: [{ type: "tool_call", id, name, arguments: { path: `f${id}.ts` } }], timestamp: 1 };
}
function userResult(callId: string, isError = false): ConversationTurn {
  return { role: "user", content: [{ type: "tool_result", callId, content: [{ type: "text", text: "x".repeat(50) }], ...(isError ? { isError: true } : {}) }], timestamp: 1 };
}
function userText(text: string): ConversationTurn {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

describe("pruning compactor preserves tool_call/tool_result pairing", () => {
  test("does not orphan a tool_result at the recent-window boundary", async () => {
    const turns: ConversationTurn[] = [
      userText("start"), userText("a"), userText("b"),
      assistantCall("c1"),   // index 3 -> would be summarized
      userResult("c1"),      // index 4 -> recent window head
      userText("c"), userText("d"), userText("e"), userText("f"), userText("g"),
    ];
    const compactor = createPruningCompactor({ keepRecentTurns: 6, maxAnchorTurns: 2, stripResultContent: true });
    const { output } = await compactor.apply(turns, {} as never);
    expect(() => assertWellFormedToolSequence(output)).not.toThrow();
  });

  test("does not reorder an anchored error result ahead of its call", async () => {
    const turns: ConversationTurn[] = [
      userText("start"),
      assistantCall("c1"),        // index 1, score 0 -> would be summarized
      userResult("c1", true),     // index 2, score 5 -> anchored
      userText("a"), userText("b"), userText("c"), userText("d"),
      userText("e"), userText("f"), userText("g"),
    ];
    const compactor = createPruningCompactor({ keepRecentTurns: 6, maxAnchorTurns: 2, stripResultContent: true });
    const { output } = await compactor.apply(turns, {} as never);
    expect(() => assertWellFormedToolSequence(output)).not.toThrow();
  });

  test("buildTurnSummary counts large tool_result payloads", () => {
    const big: ConversationTurn = {
      role: "user",
      content: [{ type: "tool_result", callId: "c1", content: [{ type: "text", text: "x".repeat(100_000) }] }],
      timestamp: 1,
    };
    const summary = buildTurnSummary([big], 2000, 0);
    const tokens = Number(summary.match(/Estimated tokens: ~(\d+)/)?.[1] ?? -1);
    // A 100KB text result is ~25000 tokens; the old String(content) bug yielded ~4.
    expect(tokens).toBeGreaterThan(20000);
  });

  test("a failed attempt buried in the summarized region survives compaction", async () => {
    // Two error pairs compete for the single anchor slot (maxAnchorTurns: 1):
    // the older (c1/run_shell) loses and falls into the summarized region,
    // the newer (c2) is anchored. The older failure only survives if the
    // fallback summary itself records it.
    function errorResult(callId: string, text: string): ConversationTurn {
      return {
        role: "user",
        content: [{ type: "tool_result", callId, content: [{ type: "text", text }], isError: true }],
        timestamp: 1,
      };
    }
    const turns: ConversationTurn[] = [
      userText("start"),
      assistantCall("c1", "run_shell"),
      errorResult("c1", "permission denied: cannot write /etc/hosts"),
      assistantCall("c2", "edit_file"),
      errorResult("c2", "syntax error in patch"),
      userText("a"), userText("b"), userText("c"), userText("d"),
      userText("e"), userText("f"), userText("g"),
    ];
    const compactor = createPruningCompactor({ keepRecentTurns: 6, maxAnchorTurns: 1, stripResultContent: true });
    const { output } = await compactor.apply(turns, {} as never);
    const summaryText = output[0]?.content.find((b) => b.type === "text")?.text ?? "";
    expect(summaryText).toContain("Failed attempts");
    expect(summaryText).toContain("run_shell");
    expect(summaryText).toContain("permission denied");
  });
});
