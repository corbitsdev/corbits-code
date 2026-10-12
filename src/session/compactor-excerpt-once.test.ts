import { describe, expect, test } from "bun:test";
import {
  createPruningCompactor,
  excerptTailTurnCallCount,
} from "./compactor.js";
import type {
  ConversationTurn,
  ReactorState,
  StrategyContext,
} from "@intx/types/runtime";

const mockStrategyCtx: StrategyContext = {
  state: {} as ReactorState,
  trigger: "test",
};

function textTurn(
  role: ConversationTurn["role"],
  text: string,
): ConversationTurn {
  return {
    role,
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

function pairTurns(id: string, resultText: string): ConversationTurn[] {
  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool_call",
          id,
          name: "read_file",
          arguments: { path: `src/${id}.ts` },
        },
      ],
      timestamp: Date.now(),
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          callId: id,
          content: [{ type: "text", text: resultText }],
        },
      ],
      timestamp: Date.now(),
    },
  ];
}

function liveResultText(turns: ConversationTurn[]): string {
  return turns
    .flatMap((t) =>
      t.content.flatMap((b) => {
        if (b.type === "text") return [b.text];
        if (b.type === "tool_result")
          return b.content.map((c) => (c.type === "text" ? c.text : ""));
        return [];
      }),
    )
    .join("\n");
}

describe("excerpt once per tail turn", () => {
  test("compactor excerpts each tail turn exactly once with identical values", async () => {
    const dump = "z".repeat(12_000);
    const turns: ConversationTurn[] = [
      textTurn("user", "do the work"),
      ...pairTurns("a", `a-result:${dump}`),
      ...pairTurns("b", `b-result:${dump}`),
      ...pairTurns("c", `c-result:${dump}`),
      textTurn("user", "newest ask"),
      textTurn("assistant", "newest reply"),
    ];

    const before = excerptTailTurnCallCount();
    const result = await createPruningCompactor({
      compactionShape: { tailBudgetTokens: 1_000_000 },
      summarize: async () => {
        throw new Error("must not invent a summary: nothing excluded");
      },
    }).apply(turns, mockStrategyCtx);

    const calls = excerptTailTurnCallCount() - before;

    expect(calls).toBe(turns.length);

    const live = liveResultText(result.output);
    expect(live.match(/\[tail-shortened \d+→/g)?.length ?? 0).toBe(3);
    expect(live).not.toContain(dump);
  });
});
