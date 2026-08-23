import { describe, expect, test } from "bun:test";
import type { ConversationTurn } from "@intx/types/runtime";
import { createPruningCompactor, buildTurnSummary } from "../../src/session/compactor.js";
import { assertWellFormedToolSequence } from "@intx/inference";

// The runtime puts a tool_call on an assistant turn and its tool_result on the
// FOLLOWING user turn, so the two halves of a pair can land on opposite sides of
// the compaction boundary. The compactor must keep pairs together; otherwise the
// inference layer rejects the compacted prompt (dangling call / orphan result).
function assistantCall(id: string, name = "read_file"): ConversationTurn {
  return {
    role: "assistant",
    content: [{ type: "tool_call", id, name, arguments: { path: `f${id}.ts` } }],
    timestamp: 1,
  };
}
function userResult(callId: string, isError = false): ConversationTurn {
  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        callId,
        content: [{ type: "text", text: "x".repeat(50) }],
        ...(isError ? { isError: true } : {}),
      },
    ],
    timestamp: 1,
  };
}
function userText(text: string): ConversationTurn {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

describe("pruning compactor preserves tool_call/tool_result pairing", () => {
  test("does not orphan a tool_result at the recent-window boundary", async () => {
    const turns: ConversationTurn[] = [
      userText("start"),
      userText("a"),
      userText("b"),
      assistantCall("c1"), // index 3 -> would be summarized
      userResult("c1"), // index 4 -> recent window head
      userText("c"),
      userText("d"),
      userText("e"),
      userText("f"),
      userText("g"),
    ];
    const compactor = createPruningCompactor({ keepRecentTurns: 6, maxAnchorTurns: 2 });
    const { output } = await compactor.apply(turns, {} as never);
    expect(() => assertWellFormedToolSequence(output)).not.toThrow();
  });

  test("does not reorder an anchored error result ahead of its call", async () => {
    const turns: ConversationTurn[] = [
      userText("start"),
      assistantCall("c1"), // index 1, score 0 -> would be summarized
      userResult("c1", true), // index 2, score 5 -> anchored
      userText("a"),
      userText("b"),
      userText("c"),
      userText("d"),
      userText("e"),
      userText("f"),
      userText("g"),
    ];
    const compactor = createPruningCompactor({ keepRecentTurns: 6, maxAnchorTurns: 2 });
    const { output } = await compactor.apply(turns, {} as never);
    expect(() => assertWellFormedToolSequence(output)).not.toThrow();
  });

  test("keeps tool_result content in a recent-window turn across a pruning pass", async () => {
    const editResult: ConversationTurn = {
      role: "user",
      content: [
        {
          type: "tool_result",
          callId: "edit1",
          content: [{ type: "text", text: "diff applied to file.ts" }],
        },
      ],
      timestamp: 1,
    };
    const turns: ConversationTurn[] = [
      userText("start"),
      userText("a"),
      userText("b"),
      userText("c"),
      userText("d"),
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "edit1", name: "edit_file", arguments: { path: "file.ts" } },
        ],
        timestamp: 1,
      },
      editResult,
      userText("e"),
      userText("f"),
      userText("g"),
    ];
    const compactor = createPruningCompactor({ keepRecentTurns: 6, maxAnchorTurns: 2 });
    const { output } = await compactor.apply(turns, {} as never);
    const kept = output.find((t) =>
      t.content.some((b) => b.type === "tool_result" && b.callId === "edit1"),
    );
    const resultBlock = kept?.content.find((b) => b.type === "tool_result" && b.callId === "edit1");
    expect(resultBlock).toMatchObject({
      content: [{ type: "text", text: "diff applied to file.ts" }],
    });
  });

  test("keeps tool_result content in an anchored file-edit turn pulled forward from the discarded middle", async () => {
    const editResult: ConversationTurn = {
      role: "user",
      content: [
        {
          type: "tool_result",
          callId: "edit1",
          content: [{ type: "text", text: "diff applied to file.ts" }],
        },
      ],
      timestamp: 1,
    };
    const turns: ConversationTurn[] = [
      userText("start"),
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "edit1", name: "edit_file", arguments: { path: "file.ts" } },
        ],
        timestamp: 1,
      },
      editResult,
      userText("a"),
      userText("b"),
      userText("c"),
      userText("d"),
      userText("e"),
      userText("f"),
      userText("g"),
    ];
    const compactor = createPruningCompactor({ keepRecentTurns: 6, maxAnchorTurns: 2 });
    const { output } = await compactor.apply(turns, {} as never);
    const kept = output.find((t) =>
      t.content.some((b) => b.type === "tool_result" && b.callId === "edit1"),
    );
    const resultBlock = kept?.content.find((b) => b.type === "tool_result" && b.callId === "edit1");
    expect(resultBlock).toMatchObject({
      content: [{ type: "text", text: "diff applied to file.ts" }],
    });
  });

  test("buildTurnSummary counts large tool_result payloads", () => {
    const big: ConversationTurn = {
      role: "user",
      content: [
        {
          type: "tool_result",
          callId: "c1",
          content: [{ type: "text", text: "x".repeat(100_000) }],
        },
      ],
      timestamp: 1,
    };
    const summary = buildTurnSummary([big], 2000, 0);
    const tokens = Number(summary.match(/Estimated tokens: ~(\d+)/)?.[1] ?? -1);
    // A 100KB text result is ~25000 tokens; the old String(content) bug yielded ~4.
    expect(tokens).toBeGreaterThan(20000);
  });
});

// When the same path is read more than once and both results survive
// compaction (recent window / anchors), older successful reads become one-line
// stubs; the newest successful read stays whole; error results stay whole.
function assistantRead(id: string, path: string): ConversationTurn {
  return {
    role: "assistant",
    content: [{ type: "tool_call", id, name: "read_file", arguments: { path } }],
    timestamp: 1,
  };
}

function userReadResult(callId: string, body: string, isError = false): ConversationTurn {
  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        callId,
        content: [{ type: "text", text: body }],
        ...(isError ? { isError: true } : {}),
      },
    ],
    timestamp: 1,
  };
}

function resultText(output: ConversationTurn[], callId: string): string | undefined {
  for (const turn of output) {
    for (const block of turn.content) {
      if (block.type === "tool_result" && block.callId === callId) {
        return block.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("");
      }
    }
  }
  return undefined;
}

describe("pruning compactor stubs superseded file reads (CL-4374)", () => {
  test("stubs an older successful read of a path re-read later; newest stays whole", async () => {
    const oldBody = "OLD_CONTENT_" + "a".repeat(200);
    const newBody = "NEW_CONTENT_" + "b".repeat(200);
    // Both read pairs sit in the recent window so neither is folded into the
    // summary — only the path-dedup pass should hollow the older result.
    const turns: ConversationTurn[] = [
      userText("start"),
      userText("a"),
      userText("b"),
      userText("c"),
      assistantRead("r1", "src/hot.ts"),
      userReadResult("r1", oldBody),
      assistantRead("r2", "src/hot.ts"),
      userReadResult("r2", newBody),
      userText("d"),
      userText("e"),
    ];
    const compactor = createPruningCompactor({ keepRecentTurns: 6, maxAnchorTurns: 2 });
    const { output } = await compactor.apply(turns, {} as never);

    const older = resultText(output, "r1");
    const newer = resultText(output, "r2");
    expect(older).toBeDefined();
    expect(newer).toBe(newBody);
    expect(older).not.toBe(oldBody);
    expect(older).toMatch(/read_file/);
    expect(older).toMatch(/src\/hot\.ts/);
    expect(older).toMatch(/omitted|chars/);
    expect(older!.length).toBeLessThan(oldBody.length);
  });

  test("preserves error read results verbatim even when a later success supersedes the path", async () => {
    const errBody = "Error: ENOENT no such file " + "e".repeat(80);
    const okBody = "OK_CONTENT_" + "c".repeat(200);
    const turns: ConversationTurn[] = [
      userText("start"),
      userText("a"),
      userText("b"),
      userText("c"),
      assistantRead("r1", "src/hot.ts"),
      userReadResult("r1", errBody, true),
      assistantRead("r2", "src/hot.ts"),
      userReadResult("r2", okBody),
      userText("d"),
      userText("e"),
    ];
    const compactor = createPruningCompactor({ keepRecentTurns: 6, maxAnchorTurns: 2 });
    const { output } = await compactor.apply(turns, {} as never);

    expect(resultText(output, "r1")).toBe(errBody);
    expect(resultText(output, "r2")).toBe(okBody);
  });

  test("does not stub a sole kept successful read when a later re-read was summarized", async () => {
    // Supersession is computed only over kept turns. A re-read that lands only
    // in the summary must not hollow the surviving body.
    const soleBody = "SOLE_KEPT_" + "s".repeat(200);
    const discardedBody = "DISCARDED_" + "d".repeat(200);
    const turns: ConversationTurn[] = [
      userText("start"),
      assistantRead("old", "src/hot.ts"),
      userReadResult("old", discardedBody),
      userText("m1"),
      userText("m2"),
      userText("m3"),
      userText("m4"),
      assistantRead("kept", "src/hot.ts"),
      userReadResult("kept", soleBody),
      userText("end"),
    ];
    // keep=3 → recent is kept call + kept result + end; the older pair summarizes.
    const compactor = createPruningCompactor({ keepRecentTurns: 3, maxAnchorTurns: 0 });
    const { output } = await compactor.apply(turns, {} as never);
    expect(resultText(output, "old")).toBeUndefined();
    expect(resultText(output, "kept")).toBe(soleBody);
  });

  test("does not stub ranged reads of the same path with different offset/limit", async () => {
    const body1 = "RANGE_0_" + "a".repeat(200);
    const body2 = "RANGE_50_" + "b".repeat(200);
    const turns: ConversationTurn[] = [
      userText("start"),
      userText("a"),
      userText("b"),
      userText("c"),
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "r1",
            name: "read_file",
            arguments: { path: "src/hot.ts", offset: 0, limit: 40 },
          },
        ],
        timestamp: 1,
      },
      userReadResult("r1", body1),
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "r2",
            name: "read_file",
            arguments: { path: "src/hot.ts", offset: 50, limit: 40 },
          },
        ],
        timestamp: 1,
      },
      userReadResult("r2", body2),
      userText("d"),
      userText("e"),
    ];
    const compactor = createPruningCompactor({ keepRecentTurns: 6, maxAnchorTurns: 2 });
    const { output } = await compactor.apply(turns, {} as never);
    expect(resultText(output, "r1")).toBe(body1);
    expect(resultText(output, "r2")).toBe(body2);
  });

  test("stubs repeated identical-range reads of the same path", async () => {
    const oldBody = "OLD_RANGE_" + "a".repeat(200);
    const newBody = "NEW_RANGE_" + "b".repeat(200);
    const rangeArgs = { path: "src/hot.ts", offset: 10, limit: 20 };
    const turns: ConversationTurn[] = [
      userText("start"),
      userText("a"),
      userText("b"),
      userText("c"),
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "r1", name: "read_file", arguments: rangeArgs }],
        timestamp: 1,
      },
      userReadResult("r1", oldBody),
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "r2", name: "read_file", arguments: rangeArgs }],
        timestamp: 1,
      },
      userReadResult("r2", newBody),
      userText("d"),
      userText("e"),
    ];
    const compactor = createPruningCompactor({ keepRecentTurns: 6, maxAnchorTurns: 2 });
    const { output } = await compactor.apply(turns, {} as never);
    const older = resultText(output, "r1");
    expect(resultText(output, "r2")).toBe(newBody);
    expect(older).toBeDefined();
    expect(older).not.toBe(oldBody);
    expect(older).toMatch(/omitted|chars/);
  });
});

// grep/search_files/list_dir are replayable the same way read_file is: an
// identical later call reflects newer workspace state, so an older identical
// result is stubbed the same way an older full-file read is (CL-6906).
function assistantQuery(id: string, name: string, args: Record<string, unknown>): ConversationTurn {
  return {
    role: "assistant",
    content: [{ type: "tool_call", id, name, arguments: args }],
    timestamp: 1,
  };
}

describe("pruning compactor extends superseded-result stubbing to query tools (CL-6906)", () => {
  test("stubs an older successful grep call repeated with byte-identical arguments", async () => {
    const oldBody = "OLD_MATCHES_" + "a".repeat(200);
    const newBody = "NEW_MATCHES_" + "b".repeat(200);
    const args = { pattern: "TODO", path: "src" };
    const turns: ConversationTurn[] = [
      userText("start"),
      userText("a"),
      userText("b"),
      userText("c"),
      assistantQuery("g1", "grep", args),
      userReadResult("g1", oldBody),
      assistantQuery("g2", "grep", args),
      userReadResult("g2", newBody),
      userText("d"),
      userText("e"),
    ];
    const compactor = createPruningCompactor({ keepRecentTurns: 6, maxAnchorTurns: 2 });
    const { output } = await compactor.apply(turns, {} as never);
    const older = resultText(output, "g1");
    expect(resultText(output, "g2")).toBe(newBody);
    expect(older).toBeDefined();
    expect(older).not.toBe(oldBody);
    expect(older).toMatch(/omitted|chars/);
  });

  test("stubs an older successful search_files call with argument key order irrelevant", async () => {
    const oldBody = "OLD_SEARCH_" + "a".repeat(200);
    const newBody = "NEW_SEARCH_" + "b".repeat(200);
    const turns: ConversationTurn[] = [
      userText("start"),
      userText("a"),
      userText("b"),
      userText("c"),
      assistantQuery("s1", "search_files", { query: "widget", limit: 20 }),
      userReadResult("s1", oldBody),
      // Same arguments, different key order — must still be treated as identical.
      assistantQuery("s2", "search_files", { limit: 20, query: "widget" }),
      userReadResult("s2", newBody),
      userText("d"),
      userText("e"),
    ];
    const compactor = createPruningCompactor({ keepRecentTurns: 6, maxAnchorTurns: 2 });
    const { output } = await compactor.apply(turns, {} as never);
    expect(resultText(output, "s2")).toBe(newBody);
    expect(resultText(output, "s1")).not.toBe(oldBody);
  });

  test("stubs an older successful list_dir call repeated on the same path", async () => {
    const oldBody = "OLD_LISTING_" + "a".repeat(200);
    const newBody = "NEW_LISTING_" + "b".repeat(200);
    const args = { path: "src/components" };
    const turns: ConversationTurn[] = [
      userText("start"),
      userText("a"),
      userText("b"),
      userText("c"),
      assistantQuery("l1", "list_dir", args),
      userReadResult("l1", oldBody),
      assistantQuery("l2", "list_dir", args),
      userReadResult("l2", newBody),
      userText("d"),
      userText("e"),
    ];
    const compactor = createPruningCompactor({ keepRecentTurns: 6, maxAnchorTurns: 2 });
    const { output } = await compactor.apply(turns, {} as never);
    expect(resultText(output, "l2")).toBe(newBody);
    expect(resultText(output, "l1")).not.toBe(oldBody);
  });

  test("does not supersede a grep call with different arguments", async () => {
    const body1 = "MATCHES_TODO_" + "a".repeat(200);
    const body2 = "MATCHES_FIXME_" + "b".repeat(200);
    const turns: ConversationTurn[] = [
      userText("start"),
      userText("a"),
      userText("b"),
      userText("c"),
      assistantQuery("g1", "grep", { pattern: "TODO", path: "src" }),
      userReadResult("g1", body1),
      assistantQuery("g2", "grep", { pattern: "FIXME", path: "src" }),
      userReadResult("g2", body2),
      userText("d"),
      userText("e"),
    ];
    const compactor = createPruningCompactor({ keepRecentTurns: 6, maxAnchorTurns: 2 });
    const { output } = await compactor.apply(turns, {} as never);
    expect(resultText(output, "g1")).toBe(body1);
    expect(resultText(output, "g2")).toBe(body2);
  });

  test("never supersedes run_shell results, even with byte-identical commands", async () => {
    // The same shell command is not idempotent (builds, tests, mutations can
    // each produce a genuinely different outcome), so run_shell is excluded
    // from replayable-result stubbing entirely.
    const oldBody = "OLD_SHELL_OUTPUT_" + "a".repeat(200);
    const newBody = "NEW_SHELL_OUTPUT_" + "b".repeat(200);
    const args = { command: "npm test" };
    const turns: ConversationTurn[] = [
      userText("start"),
      userText("a"),
      userText("b"),
      userText("c"),
      assistantQuery("sh1", "run_shell", args),
      userReadResult("sh1", oldBody),
      assistantQuery("sh2", "run_shell", args),
      userReadResult("sh2", newBody),
      userText("d"),
      userText("e"),
    ];
    const compactor = createPruningCompactor({ keepRecentTurns: 6, maxAnchorTurns: 2 });
    const { output } = await compactor.apply(turns, {} as never);
    expect(resultText(output, "sh1")).toBe(oldBody);
    expect(resultText(output, "sh2")).toBe(newBody);
  });
});
