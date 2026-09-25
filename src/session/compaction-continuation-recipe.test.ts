import { describe, expect, test } from "bun:test";
import type {
  ConversationTurn,
  ReactorState,
  StrategyContext,
} from "@intx/types/runtime";
import { createPruningCompactor } from "./compactor.js";

// CL-8980 RED: compaction must not delete the only working resume recipe for
// an unfinished large read. When the same file is read twice among the kept
// turns, the older result is stubbed — but if that older result carries a
// truncated-read continuation notice (an unconsumed cursor), the stub must
// preserve the resume recipe (handle, or source + offset). Today the stub
// drops it, leaving the model with no way forward.

const mockStrategyCtx: StrategyContext = {
  state: {} as ReactorState,
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

const CURSOR_HANDLE = "tool-output:///cursor-aaaabbbbccccdddd";

function truncatedResultBody(): string {
  return [
    "huge-line-0",
    "huge-line-1",
    "huge-line-2",
    "huge-line-3",
    "",
    `[Showing lines 1-4; stopped at the 4-line limit. Use path="${CURSOR_HANDLE}" (same tool, no offset needed) — not the original path. Safe to retry after any truncation warning.]`,
  ].join("\n");
}

function identicalReadPair(): ConversationTurn[] {
  const first: ConversationTurn[] = [
    makeTurn({
      role: "assistant",
      content: [
        {
          type: "tool_call",
          id: "old-read",
          name: "read_file",
          arguments: { path: "huge.txt", limit: 4 },
        },
      ],
    }),
    makeTurn({
      role: "user",
      content: [
        {
          type: "tool_result",
          callId: "old-read",
          content: [{ type: "text", text: truncatedResultBody() }],
        },
      ],
    }),
  ];
  const second: ConversationTurn[] = [
    makeTurn({
      role: "assistant",
      content: [
        {
          type: "tool_call",
          id: "new-read",
          name: "read_file",
          arguments: { path: "huge.txt", limit: 4 },
        },
      ],
    }),
    makeTurn({
      role: "user",
      content: [
        {
          type: "tool_result",
          callId: "new-read",
          content: [{ type: "text", text: truncatedResultBody() }],
        },
      ],
    }),
  ];
  return [...first, ...second];
}

function turnText(turn: ConversationTurn): string {
  return turn.content
    .map((block) =>
      block.type === "text"
        ? block.text
        : block.type === "tool_result"
          ? block.content.map((c) => (c.type === "text" ? c.text : "")).join("")
          : "",
    )
    .join("");
}

describe("CL-8980 compaction preserves the resume recipe", () => {
  // Both identical reads sit inside the kept recent window (so the older
  // stubs) while plain filler turns ahead of them summarize away (so the
  // fold actually runs instead of no-op'ing).
  function auditTranscript(): ConversationTurn[] {
    return [
      makeTurn({
        role: "user",
        content: [
          { type: "text", text: "goal: audit the huge export file end to end" },
        ],
      }),
      makeTurn({
        role: "user",
        content: [{ type: "text", text: "background note one for the audit" }],
      }),
      makeTurn({
        role: "assistant",
        content: [{ type: "text", text: "background note two for the audit" }],
      }),
      makeTurn({
        role: "user",
        content: [{ type: "text", text: "background note three, then start" }],
      }),
      ...identicalReadPair(),
      makeTurn({
        role: "user",
        content: [{ type: "text", text: "noted, keep going with the audit" }],
      }),
      makeTurn({
        role: "user",
        content: [{ type: "text", text: "keep going with the audit" }],
      }),
      makeTurn({
        role: "assistant",
        content: [{ type: "text", text: "continuing the audit" }],
      }),
      makeTurn({
        role: "user",
        content: [{ type: "text", text: "anything else in the export?" }],
      }),
      makeTurn({
        role: "assistant",
        content: [{ type: "text", text: "still auditing" }],
      }),
    ];
  }

  test("stubbing a superseded truncated read keeps the continuation handle", async () => {
    const compactor = createPruningCompactor({
      keepRecentTurns: 8,
      summaryMaxChars: 4000,
      maxAnchorTurns: 2,
    });
    const applied = await compactor.apply(auditTranscript(), mockStrategyCtx);
    expect(applied.record.decisions.supersededReadCount).toBe(1);

    const oldResult = applied.output.find((turn) =>
      turn.content.some(
        (block) => block.type === "tool_result" && block.callId === "old-read",
      ),
    );
    expect(oldResult).toBeDefined();
    const stub = turnText(oldResult as ConversationTurn);
    expect(stub).not.toContain("huge-line-0");
    // The only working resume recipe for this unfinished read must survive.
    expect(stub).toContain(CURSOR_HANDLE);
  });

  test("the newest truncated read stays whole so its notice keeps working", async () => {
    const compactor = createPruningCompactor({
      keepRecentTurns: 8,
      summaryMaxChars: 4000,
      maxAnchorTurns: 2,
    });
    const applied = await compactor.apply(auditTranscript(), mockStrategyCtx);
    const newResult = applied.output.find((turn) =>
      turn.content.some(
        (block) => block.type === "tool_result" && block.callId === "new-read",
      ),
    );
    expect(newResult).toBeDefined();
    const body = turnText(newResult as ConversationTurn);
    expect(body).toContain("huge-line-3");
    expect(body).toContain(CURSOR_HANDLE);
  });
});
