import { defined } from "../testkit/defined.js";
import { describe, test, expect } from "bun:test";
import {
  createPruningCompactor,
  compactorNoOpFloor,
  buildTurnSummary,
  COMPACTED_PREFIX,
  COMPACT_SPACER_TEXT,
  LEGACY_COMPACT_SPACER_TEXT,
  HARNESS_COMPACT_SPACER_MODEL,
  isHarnessCompactSpacer,
  DEFAULT_TAIL_COMPACTION_SHAPE,
} from "./session/compactor.js";
import { HANDOFF_LATEST_KEY } from "./session/compaction-handoff.js";
import { compactionThresholdFor } from "./provider/context-window.js";
import { estimateContextTokens } from "./agent/context-estimate.js";
import { createModelSummarizer } from "./session/summarizer.js";
import {
  createCompactionGovernor,
  stickyExtraInstructionsFromRecords,
} from "./agent/compaction.js";
import type {
  ConversationTurn,
  InferenceSource,
  ReactorState,
  StrategyContext,
} from "@intx/types/runtime";

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

// Every text block across every turn, so assertions can check that content
// survives compaction without depending on how turns are merged.
function allText(turns: ConversationTurn[]): string {
  return turns
    .flatMap((t) =>
      t.content.filter((b) => b.type === "text").map((b) => b.text),
    )
    .join("\n");
}

function handoffFile(
  blobs: { key: string; bytes: Uint8Array }[] | undefined,
): string {
  const blob = blobs?.find((b) => b.key === HANDOFF_LATEST_KEY);
  return blob === undefined ? "" : new TextDecoder().decode(blob.bytes);
}

function hasConsecutiveSameRole(turns: ConversationTurn[]): boolean {
  return turns.some((t, i) => i > 0 && defined(turns[i - 1]).role === t.role);
}

type CompactorConfig = Parameters<typeof createPruningCompactor>[0];

// CL-9489: every test pins a tiny tail budget so the fold covers older
// turns the token cap leaves out. Pass tailBudgetTokens instead of a full
// compactionShape.
function smallCompactor(
  cfg: Omit<NonNullable<CompactorConfig>, "compactionShape"> & {
    tailBudgetTokens?: number;
  },
): ReturnType<typeof createPruningCompactor> {
  const { tailBudgetTokens = 10, ...rest } = cfg;
  return createPruningCompactor({
    ...rest,
    compactionShape: { tailBudgetTokens },
  });
}

describe("createPruningCompactor", () => {
  test("returns turns unchanged when under the keep threshold", async () => {
    const compactor = smallCompactor({
      summaryMaxChars: 500,
    });
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
    const compactor = smallCompactor({
      summaryMaxChars: 500,
    });
    const floor = compactorNoOpFloor();

    // Bodies exceed the pinned tail budget, so past-floor always has a folded
    // region while at-floor still no-ops on the count check alone.
    const body = (i: number): string => `body ${i} ` + "x".repeat(100);
    const atFloor = Array.from({ length: floor }, (_, i) =>
      makeTurn({
        role: i % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: body(i) }],
      }),
    );
    // Past the count floor AND past the tail budget: initiating + middle + tail
    // so there is a summarized region, not a keep-set no-op.
    const pastFloor = Array.from({ length: floor + 3 }, (_, i) =>
      makeTurn({
        role: i % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: body(i) }],
      }),
    );

    expect(
      (await compactor.apply(atFloor, mockStrategyCtx)).record.reason,
    ).toBe("no compaction needed");
    expect(
      (await compactor.apply(pastFloor, mockStrategyCtx)).record.reason,
    ).not.toBe("no compaction needed");
  });

  test("compacts old turns and preserves recent ones", async () => {
    const compactor = smallCompactor({
      summaryMaxChars: 500,
    });
    const turns: ConversationTurn[] = [
      makeTurn({
        role: "user",
        content: [{ type: "text", text: "old message 1" }],
      }),
      makeTurn({
        role: "assistant",
        content: [{ type: "text", text: "old response 1" }],
      }),
      makeTurn({
        role: "user",
        content: [{ type: "text", text: "old message 2" }],
      }),
      makeTurn({
        role: "assistant",
        content: [{ type: "text", text: "old response 2" }],
      }),
      makeTurn({
        role: "user",
        content: [{ type: "text", text: "recent message" }],
      }),
      makeTurn({
        role: "assistant",
        content: [{ type: "text", text: "recent response" }],
      }),
    ];

    const result = await compactor.apply(turns, mockStrategyCtx);

    // Summary leads as a user turn (survives every adapter).
    expect(defined(result.output[0]).role).toBe("user");
    expect(allText(result.output)).toContain("[Compacted prior context]");
    // The initiating user message and the recent turn both survive.
    expect(allText(result.output)).toContain("old message 1");
    expect(allText(result.output)).toContain("recent response");
    // Compaction never emits a non-alternating role sequence.
    expect(hasConsecutiveSameRole(result.output)).toBe(false);
  });
});

describe("createPruningCompactor — initiating task preservation", () => {
  test("emits the compaction summary as a user turn, never system", async () => {
    const compactor = smallCompactor({
      tailBudgetTokens: 1,
      summaryMaxChars: 500,
    });
    const turns: ConversationTurn[] = [
      makeTurn({ role: "assistant", content: [{ type: "text", text: "a" }] }),
      makeTurn({ role: "assistant", content: [{ type: "text", text: "b" }] }),
      makeTurn({ role: "user", content: [{ type: "text", text: "recent" }] }),
    ];
    const result = await compactor.apply(turns, mockStrategyCtx);
    expect(defined(result.output[0]).role).toBe("user");
    expect(result.output.every((t) => t.role !== "system")).toBe(true);
  });

  test("keeps alternating roles when a tool_result user turn abuts a plain user turn", async () => {
    const compactor = smallCompactor({
      maxAnchorTurns: 3,
      summaryMaxChars: 500,
    });
    const turns: ConversationTurn[] = [
      makeTurn({
        role: "user",
        content: [{ type: "text", text: "the initiating task" }],
      }),
      makeTurn({
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "c1",
            name: "edit_file",
            arguments: { path: "src/a.ts" },
          },
        ],
      }),
      makeTurn({
        role: "user",
        content: [
          {
            type: "tool_result",
            callId: "c1",
            content: [{ type: "text", text: "edited" }],
          },
        ],
      }),
      makeTurn({
        role: "assistant",
        content: [{ type: "text", text: "reasoning that gets summarized" }],
      }),
      makeTurn({
        role: "user",
        content: [{ type: "text", text: "the recent ask" }],
      }),
    ];
    const result = await compactor.apply(turns, mockStrategyCtx);
    // The summarized assistant turn would leave the tool_result user turn next
    // to the recent user turn; coalescing must still alternate. The edit pair
    // folds into the fat handoff rather than riding live as an unexcerpted body.
    expect(hasConsecutiveSameRole(result.output)).toBe(false);
    expect(
      result.output.some((t) =>
        t.content.some((b) => b.type === "tool_call" && b.id === "c1"),
      ),
    ).toBe(false);
    expect(handoffFile(result.blobs)).toContain("src/a.ts");
  });
});

describe("createPruningCompactor — image aging", () => {
  const imageBlock = {
    type: "image" as const,
    source: {
      kind: "base64" as const,
      mimeType: "image/png",
      data: "iVBORw0KGgo=",
    },
  };

  test("strips image bytes from an anchored (aged) turn but keeps its text", async () => {
    const compactor = smallCompactor({
      maxAnchorTurns: 1,
      summaryMaxChars: 500,
    });
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
      turns.push(
        makeTurn({
          role: "assistant",
          content: [{ type: "text", text: `step ${i}` }],
        }),
      );
    }
    turns.push(
      makeTurn({
        role: "user",
        content: [{ type: "text", text: "recent ask" }],
      }),
    );
    turns.push(
      makeTurn({
        role: "assistant",
        content: [{ type: "text", text: "recent reply" }],
      }),
    );

    const result = await compactor.apply(turns, mockStrategyCtx);

    // The full base64 payload must not appear anywhere in the materialized output.
    expect(JSON.stringify(result.output)).not.toContain("iVBORw0KGgo=");
    expect(
      result.output.some((t) => t.content.some((b) => b.type === "image")),
    ).toBe(false);
    // The initiating screenshot is outside the tail: it ages into a blob and
    // folds into the handoff rather than riding live.
    expect(handoffFile(result.blobs)).toContain(
      "here's a screenshot of the bug",
    );
    expect(result.blobs).toBeDefined();
    expect(defined(result.blobs).length).toBeGreaterThanOrEqual(1);
    expect(
      defined(result.blobs).some((b) => b.contentType === "image/png"),
    ).toBe(true);
    expect(
      new TextDecoder().decode(
        defined(
          defined(result.blobs).find((b) => b.contentType === "image/png"),
        ).bytes,
      ),
    ).toBe("iVBORw0KGgo=");
  });

  test("keeps an image intact when its turn is in the budgeted tail", async () => {
    const compactor = smallCompactor({
      tailBudgetTokens: 500,
      summaryMaxChars: 500,
    });
    const turns: ConversationTurn[] = [
      makeTurn({ role: "user", content: [{ type: "text", text: "old 1" }] }),
      makeTurn({
        role: "assistant",
        content: [{ type: "text", text: "old 2" }],
      }),
      makeTurn({
        role: "user",
        content: [{ type: "text", text: "here's a screenshot" }, imageBlock],
      }),
      makeTurn({
        role: "assistant",
        content: [{ type: "text", text: "looking at it" }],
      }),
      makeTurn({
        role: "user",
        content: [{ type: "text", text: "recent ask" }],
      }),
    ];

    const result = await compactor.apply(turns, mockStrategyCtx);

    expect(JSON.stringify(result.output)).toContain("iVBORw0KGgo=");
  });

  test("ages images outside the budgeted tail", async () => {
    // Tiny tail budget keeps only the newest text; the older screenshot ages.
    const compactor = smallCompactor({
      tailBudgetTokens: 1,
      summaryMaxChars: 500,
    });
    const turns: ConversationTurn[] = [
      makeTurn({
        role: "user",
        content: [{ type: "text", text: "old screenshot" }, imageBlock],
      }),
      makeTurn({
        role: "assistant",
        content: [{ type: "text", text: "noted" }],
      }),
      makeTurn({
        role: "user",
        content: [{ type: "text", text: "recent ask" }],
      }),
      makeTurn({
        role: "assistant",
        content: [{ type: "text", text: "recent reply" }],
      }),
    ];

    const result = await compactor.apply(turns, mockStrategyCtx);

    expect(JSON.stringify(result.output)).not.toContain("iVBORw0KGgo=");
    expect(result.blobs).toBeDefined();
    expect(defined(result.blobs).length).toBeGreaterThanOrEqual(1);
    expect(
      defined(result.blobs).some((b) => b.contentType === "image/png"),
    ).toBe(true);
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
      content: [
        {
          type: "tool_result",
          callId,
          content: [{ type: "text", text }],
          isError: true,
        },
      ],
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
      makeTurn({
        role: "user",
        content: [{ type: "text", text: "the initiating task" }],
      }),
      ...padding(3, "before"),
      assistantErrorCall("e1", "run_shell"),
      errorResult("e1", "Error: exit code 1 " + "x".repeat(100)),
      ...padding(8, "after"),
    ];
    const compactor = smallCompactor({
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
      makeTurn({
        role: "user",
        content: [{ type: "text", text: "the initiating task" }],
      }),
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
    const compactor = smallCompactor({
      maxAnchorTurns: 8,
      summaryMaxChars: 2000,
    });
    const { output, blobs } = await compactor.apply(turns, mockStrategyCtx);
    const kept = output.find((t) =>
      t.content.some((b) => b.type === "tool_result" && b.callId === "d1"),
    );
    expect(kept).toBeUndefined();
    const file = handoffFile(blobs);
    expect(file).toContain("Error: build failed");
    expect(file).toContain("Error: no matches found");
  });

  test("repeated identical errors collapse to one representative before anchor selection", async () => {
    // "old" repeats the same (tool, error-text) signature that recurs again
    // later ("recur"); combined with a distinct error on the same turn, the
    // uncollapsed score (3 + 3 = 6) would clear the threshold, but the
    // collapsed score (0 + 3 = 3) must not.
    const sharedErrorText = "Error: type mismatch on line 12, expected string";
    const turns: ConversationTurn[] = [
      makeTurn({
        role: "user",
        content: [{ type: "text", text: "the initiating task" }],
      }),
      ...padding(3, "before"),
      makeTurn({
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "old",
            name: "edit_file_check",
            arguments: {},
          },
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
    const compactor = smallCompactor({
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

describe("createPruningCompactor — summarize receives the workflow context (CL-6906)", () => {
  test("passes cfg.summaryContext() through to summarize as the second argument", async () => {
    let capturedCtx: unknown = "not called";
    const workflowCtx = { workflow: { name: "build", stepIndex: 2, total: 7 } };
    const compactor = smallCompactor({
      tailBudgetTokens: 1,
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

describe("createPruningCompactor — operator extra instructions", () => {
  test("stores extra instructions on the compact record", async () => {
    const compactor = smallCompactor({
      summaryMaxChars: 500,
      summaryContext: () => ({ extraInstructions: "keep the auth discussion" }),
      summarize: async () => "summary text",
    });
    const turns: ConversationTurn[] = [
      makeTurn({ role: "assistant", content: [{ type: "text", text: "a" }] }),
      makeTurn({ role: "assistant", content: [{ type: "text", text: "b" }] }),
      makeTurn({ role: "user", content: [{ type: "text", text: "recent" }] }),
    ];
    const result = await compactor.apply(turns, mockStrategyCtx);
    expect(result.record.parameters.extraInstructions).toBe(
      "keep the auth discussion",
    );
  });

  test("a rebuilt governor still passes stored extra instructions into the next fold", async () => {
    const turns: ConversationTurn[] = [
      makeTurn({ role: "assistant", content: [{ type: "text", text: "a" }] }),
      makeTurn({ role: "assistant", content: [{ type: "text", text: "b" }] }),
      makeTurn({ role: "user", content: [{ type: "text", text: "recent" }] }),
    ];
    const written = await smallCompactor({
      tailBudgetTokens: 1,
      summaryMaxChars: 500,
      summaryContext: () => ({ extraInstructions: "keep the auth discussion" }),
      summarize: async () => "summary text",
    }).apply(turns, mockStrategyCtx);

    const rebuilt = createCompactionGovernor(undefined);
    rebuilt.restoreExtraInstructions(
      stickyExtraInstructionsFromRecords([written.record]),
    );

    let captured: { extraInstructions?: string } | undefined;
    const next = await smallCompactor({
      tailBudgetTokens: 1,
      summaryMaxChars: 500,
      summaryContext: () => {
        const extra = rebuilt.extraInstructions;
        return extra !== undefined ? { extraInstructions: extra } : undefined;
      },
      summarize: async (_folded, ctx) => {
        captured = ctx;
        return "later summary";
      },
    }).apply(turns, mockStrategyCtx);

    expect(captured?.extraInstructions).toBe("keep the auth discussion");
    expect(next.record.parameters.extraInstructions).toBe(
      "keep the auth discussion",
    );
  });
});

describe("createPruningCompactor — consolidated handoff (CL-7521)", () => {
  function firstText(turn: ConversationTurn): string {
    const block = turn.content.find((b) => b.type === "text");
    return block !== undefined && block.type === "text" ? block.text : "";
  }

  function compactedTurns(output: ConversationTurn[]): ConversationTurn[] {
    return output.filter((t) => firstText(t).startsWith(COMPACTED_PREFIX));
  }

  function grow(
    base: ConversationTurn[],
    count: number,
    label: string,
  ): ConversationTurn[] {
    const extra: ConversationTurn[] = [];
    for (let i = 0; i < count; i++) {
      extra.push(
        makeTurn({
          role: i % 2 === 0 ? "user" : "assistant",
          content: [{ type: "text", text: `${label} ${i}` }],
        }),
      );
    }
    return [...base, ...extra];
  }

  test("second apply keeps the initiating task in the handoff, not as a live user turn", async () => {
    const compactor = smallCompactor({
      maxAnchorTurns: 1,
      summaryMaxChars: 500,
    });
    const goal = "GOAL: migrate the auth module to opaque tokens";
    const turns: ConversationTurn[] = [
      makeTurn({ role: "user", content: [{ type: "text", text: goal }] }),
    ];
    for (let i = 0; i < 8; i++) {
      turns.push(
        makeTurn({
          role: "assistant",
          content: [{ type: "text", text: `step ${i}` }],
        }),
      );
    }
    turns.push(
      makeTurn({
        role: "user",
        content: [{ type: "text", text: "also handle refresh" }],
      }),
    );
    turns.push(
      makeTurn({
        role: "assistant",
        content: [{ type: "text", text: "recent reply" }],
      }),
    );
    turns.push(
      makeTurn({
        role: "user",
        content: [{ type: "text", text: "recent ask" }],
      }),
    );

    const output1 = (await compactor.apply(turns, mockStrategyCtx)).output;
    expect(allText(output1)).toContain(goal);

    const result2 = await compactor.apply(
      grow(output1, 16, "round2"),
      mockStrategyCtx,
    );
    expect(compactedTurns(result2.output)).toHaveLength(1);
    expect(handoffFile(result2.blobs)).toContain(goal);
    expect(hasConsecutiveSameRole(result2.output)).toBe(false);
  });

  test("harness spacer is stamped with the reserved producer id and a visible sentinel", async () => {
    const compactor = smallCompactor({
      tailBudgetTokens: 1,
      summaryMaxChars: 500,
    });
    const turns: ConversationTurn[] = [
      makeTurn({
        role: "user",
        content: [{ type: "text", text: "the initiating task" }],
      }),
    ];
    for (let i = 0; i < 8; i++) {
      turns.push(
        makeTurn({
          role: "assistant",
          content: [{ type: "text", text: `step ${i}` }],
        }),
      );
    }
    turns.push(
      makeTurn({
        role: "user",
        content: [{ type: "text", text: "recent ask" }],
      }),
    );
    const output = (await compactor.apply(turns, mockStrategyCtx)).output;
    const spacer = output.find(isHarnessCompactSpacer);
    expect(spacer).toBeDefined();
    expect(defined(spacer).model).toBe(HARNESS_COMPACT_SPACER_MODEL);
    expect(firstText(defined(spacer))).toBe(COMPACT_SPACER_TEXT);
    expect(firstText(defined(spacer))).not.toBe(LEGACY_COMPACT_SPACER_TEXT);
  });

  test("model-emitted spacer is not treated as a harness spacer", async () => {
    const echo = makeTurn({
      role: "assistant",
      model: "omen-alpha",
      content: [{ type: "text", text: LEGACY_COMPACT_SPACER_TEXT }],
    });
    const stamped = makeTurn({
      role: "assistant",
      model: "omen-alpha",
      content: [{ type: "text", text: COMPACT_SPACER_TEXT }],
    });
    expect(isHarnessCompactSpacer(echo)).toBe(false);
    expect(isHarnessCompactSpacer(stamped)).toBe(false);
  });

  test("legacy harness spacer without model is still recognized", () => {
    const legacySpacer = makeTurn({
      role: "assistant",
      content: [{ type: "text", text: LEGACY_COMPACT_SPACER_TEXT }],
    });
    expect(isHarnessCompactSpacer(legacySpacer)).toBe(true);
  });

  test("empty-fold keep-set returns the input unchanged", async () => {
    const compactor = smallCompactor({
      tailBudgetTokens: 500,
      maxAnchorTurns: 8,
      summaryMaxChars: 500,
    });
    const turns: ConversationTurn[] = [
      makeTurn({
        role: "user",
        content: [{ type: "text", text: "the initiating task" }],
      }),
      makeTurn({
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "c1",
            name: "edit_file",
            arguments: { path: "src/a.ts" },
          },
        ],
      }),
      makeTurn({ role: "user", content: [{ type: "text", text: "recent" }] }),
    ];
    const result = await compactor.apply(turns, mockStrategyCtx);
    expect(result.output).toBe(turns);
    expect(result.record.reason).toBe("no compaction needed");
  });

  test("failing summarizer folds with a statistics-only stub; a later success writes one handoff", async () => {
    const source: InferenceSource = {
      id: "test",
      provider: "openai",
      model: "test-model",
      baseURL: "http://localhost:1",
      credentialId: "test",
    };
    let calls = 0;
    const summarize = createModelSummarizer({
      getSource: () => source,
      complete: async () => {
        calls++;
        if (calls === 1) throw new Error("model unreachable");
        return "UNIQUE_SUCCESS_SUMMARY";
      },
    });
    const compactor = smallCompactor({
      summaryMaxChars: 500,
      summarize,
    });
    const turns = grow([], 16, "fail");
    const result1 = await compactor.apply(turns, mockStrategyCtx);
    expect(result1.output).not.toBe(turns);
    expect(result1.record.reason).toContain("statistics-only stub");
    expect(result1.record.decisions.summarizeFailed).toBe(1);
    expect(result1.record.decisions.summarizeFailureKind).toBe("failed");
    expect(compactedTurns(result1.output)).toHaveLength(1);
    const stubHandoff = defined(defined(result1.blobs)[0]);
    expect(new TextDecoder().decode(stubHandoff.bytes)).toContain(
      "Turns compacted:",
    );

    const result2 = await compactor.apply(
      grow(result1.output, 16, "ok"),
      mockStrategyCtx,
    );
    expect(compactedTurns(result2.output)).toHaveLength(1);
    // CL-8744: the narrative lives in the fat handoff file, not the prompt.
    // The live output carries only the thin spine plus its pointer.
    expect(allText(result2.output)).not.toContain("UNIQUE_SUCCESS_SUMMARY");
    const handoffBlob = defined(
      defined(result2.blobs).find(
        (blob) => blob.contentType === "text/markdown",
      ),
    );
    expect(new TextDecoder().decode(handoffBlob.bytes)).toContain(
      "UNIQUE_SUCCESS_SUMMARY",
    );
    expect(allText(result2.output)).toContain(
      `Handoff: tool-output:///${handoffBlob.key}`,
    );
    expect(hasConsecutiveSameRole(result2.output)).toBe(false);
  });

  test("empty summarizer output folds with a statistics-only stub", async () => {
    const source: InferenceSource = {
      id: "test",
      provider: "openai",
      model: "test-model",
      baseURL: "http://localhost:1",
      credentialId: "test",
    };
    const summarize = createModelSummarizer({
      getSource: () => source,
      complete: async () => "",
    });
    const result = await smallCompactor({
      summaryMaxChars: 500,
      summarize,
    }).apply(grow([], 16, "empty"), mockStrategyCtx);
    expect(result.record.decisions.summarizeFailed).toBe(1);
    expect(result.record.decisions.summarizeFailureKind).toBe("empty");
    expect(result.record.reason).toContain("statistics-only stub: empty");
    expect(compactedTurns(result.output)).toHaveLength(1);
  });

  test("an aborted summarizer keeps prior context instead of stubbing", async () => {
    const err = new Error("aborted by lifecycle");
    err.name = "AbortError";
    const turns = grow([], 16, "abort");
    const result = await smallCompactor({
      summaryMaxChars: 500,
      summarize: async () => {
        throw err;
      },
    }).apply(turns, mockStrategyCtx);
    expect(result.output).toBe(turns);
    expect(result.record.reason).toBe("summarize failed");
    expect(result.record.decisions.summarizeFailed).toBe(1);
    expect(result.record.decisions.summarizedTurnCount).toBeUndefined();
  });
});

describe("buildTurnSummary via createPruningCompactor", () => {
  test("summarizes tool_call and tool_result blocks in compacted turns", async () => {
    const compactor = smallCompactor({
      summaryMaxChars: 2000,
    });
    const turns: ConversationTurn[] = [
      makeTurn({
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "c1",
            name: "read_file",
            arguments: { path: "src/foo.ts" },
          },
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
    const spineText = (
      defined(defined(result.output[0]).content[0]) as { text: string }
    ).text;
    // CL-8744: the live output carries only the thin spine (goal one-liner,
    // evidence echo, explicit pointer) — file lists and counts stay in the
    // fat handoff file, where they cannot make the next spine novel.
    expect(spineText).toContain("[Compacted prior context]");
    expect(spineText).toContain("Handoff: tool-output:///");
    expect(spineText).not.toContain("src/foo.ts");
    // The structured tool memory lives in the fat handoff file.
    const file = new TextDecoder().decode(
      defined(defined(result.blobs)[0]).bytes,
    );
    expect(file).toContain("src/foo.ts");
    expect(file).toContain("paths: src/foo.ts");
    expect(file).toContain("turns: 2, tool calls: 1");
    expect(file).toContain("read_file");
    expect(file).toContain("Total tool calls: 1");
  });

  test("buildTurnSummary truncates with ellipsis when over maxChars", () => {
    const maxChars = 20;
    const turns: ConversationTurn[] = [
      makeTurn({
        role: "user",
        content: [{ type: "text", text: "migrate opaque tokens ".repeat(40) }],
      }),
      makeTurn({
        role: "assistant",
        content: [
          { type: "text", text: "patch the refresh handler ".repeat(40) },
        ],
      }),
    ];
    const summary = buildTurnSummary(turns, maxChars);
    expect(summary.endsWith("...")).toBe(true);
    expect(summary.length).toBe(maxChars);
  });
});

describe("CL-9489 zero-verbatim fold", () => {
  function liveTokenEstimate(turns: ConversationTurn[]): number {
    let chars = 0;
    for (const turn of turns) {
      for (const block of turn.content) {
        if (block.type === "text") chars += block.text.length;
        else if (block.type === "tool_call")
          chars += JSON.stringify(block.arguments).length;
        else if (block.type === "tool_result") {
          for (const part of block.content) {
            if (part.type === "text") chars += part.text.length;
          }
        }
      }
    }
    return Math.ceil(chars / 4);
  }

  test("a large recent-tool-result session folds under the 60% trigger", async () => {
    const dump = "z".repeat(20_000);
    const turns: ConversationTurn[] = [
      makeTurn({
        role: "user",
        content: [{ type: "text", text: "audit the deployment logs" }],
      }),
    ];
    for (let i = 0; i < 20; i++) {
      turns.push(
        makeTurn({
          role: "assistant",
          content: [
            {
              type: "tool_call",
              id: `r${i}`,
              name: "read_file",
              arguments: { path: `src/f${i}.ts` },
            },
          ],
        }),
      );
      turns.push(
        makeTurn({
          role: "user",
          content: [
            {
              type: "tool_result",
              callId: `r${i}`,
              content: [{ type: "text", text: dump }],
            },
          ],
        }),
      );
    }
    turns.push(
      makeTurn({
        role: "user",
        content: [{ type: "text", text: "newest ask" }],
      }),
    );

    const before = liveTokenEstimate(turns);
    expect(before).toBeGreaterThan(compactionThresholdFor(undefined));

    const result = await createPruningCompactor({
      summarize: async () =>
        "Audited deployment logs. Next: keep newest ask whole.",
    }).apply(turns, mockStrategyCtx);

    expect(result.record.reason.startsWith("compacted")).toBe(true);
    expect(allText(result.output)).toContain(COMPACTED_PREFIX);
    expect(allText(result.output)).toContain("Handoff: tool-output:///");
    const after = liveTokenEstimate(result.output);
    expect(after).toBeLessThan(compactionThresholdFor(undefined));
    expect(Number(result.record.decisions["tailBudgetTokens"])).toBe(
      DEFAULT_TAIL_COMPACTION_SHAPE.tailBudgetTokens,
    );
    expect(
      Number(result.record.decisions["tailTokenEstimate"]),
    ).toBeLessThanOrEqual(DEFAULT_TAIL_COMPACTION_SHAPE.tailBudgetTokens + 50);
    const liveBodies = result.output
      .flatMap((t) =>
        t.content.flatMap((b) => {
          if (b.type === "tool_result")
            return b.content.map((c) => (c.type === "text" ? c.text : ""));
          return [];
        }),
      )
      .join("\n");
    expect(liveBodies).not.toContain(dump);
  });

  test("fat edit_file anchors fold into the handoff, not the live prompt", async () => {
    const body = "x".repeat(20_000);
    const turns: ConversationTurn[] = [
      makeTurn({
        role: "user",
        content: [{ type: "text", text: "patch eight files" }],
      }),
    ];
    for (let i = 0; i < 8; i++) {
      turns.push(
        makeTurn({
          role: "assistant",
          content: [
            {
              type: "tool_call",
              id: `e${i}`,
              name: "edit_file",
              arguments: { path: `src/f${i}.ts`, oldText: body, newText: body },
            },
          ],
        }),
      );
      turns.push(
        makeTurn({
          role: "user",
          content: [
            {
              type: "tool_result",
              callId: `e${i}`,
              content: [{ type: "text", text: `applied ${i}` }],
            },
          ],
        }),
      );
    }
    turns.push(
      makeTurn({
        role: "user",
        content: [{ type: "text", text: "newest ask" }],
      }),
    );

    const before = estimateContextTokens(turns);
    expect(before).toBeGreaterThan(compactionThresholdFor(undefined));

    const result = await createPruningCompactor({
      summarize: async () => "Patched eight files. Next: newest ask.",
    }).apply(turns, mockStrategyCtx);

    expect(result.record.reason.startsWith("compacted")).toBe(true);
    expect(Number(result.record.decisions["anchorTurnCount"])).toBe(0);
    const liveEdit = result.output.some((t) =>
      t.content.some(
        (b) =>
          b.type === "tool_call" &&
          b.name === "edit_file" &&
          JSON.stringify(b.arguments).includes(body),
      ),
    );
    expect(liveEdit).toBe(false);
    expect(handoffFile(result.blobs)).toContain("src/f0.ts");
    const after = estimateContextTokens(result.output);
    expect(after).toBeLessThan(compactionThresholdFor(undefined));
    expect(after).toBeLessThan(76_800);
  });

  test("a huge newest screenshot counts against the tail budget", async () => {
    const dump = "z".repeat(20_000);
    const screenshot = "A".repeat(20_000);
    const turns: ConversationTurn[] = [
      makeTurn({
        role: "user",
        content: [{ type: "text", text: "audit the logs" }],
      }),
    ];
    for (let i = 0; i < 8; i++) {
      turns.push(
        makeTurn({
          role: "assistant",
          content: [
            {
              type: "tool_call",
              id: `r${i}`,
              name: "read_file",
              arguments: { path: `src/f${i}.ts` },
            },
          ],
        }),
      );
      turns.push(
        makeTurn({
          role: "user",
          content: [
            {
              type: "tool_result",
              callId: `r${i}`,
              content: [{ type: "text", text: dump }],
            },
          ],
        }),
      );
    }
    turns.push(
      makeTurn({
        role: "user",
        content: [
          { type: "text", text: "look at this screenshot" },
          {
            type: "image",
            source: {
              kind: "base64",
              mimeType: "image/png",
              data: screenshot,
            },
          },
        ],
      }),
    );

    const result = await createPruningCompactor({
      summarize: async () => "Audited logs. Next: inspect the screenshot.",
    }).apply(turns, mockStrategyCtx);

    expect(result.record.reason.startsWith("compacted")).toBe(true);
    const tailTokens = Number(result.record.decisions["tailTokenEstimate"]);
    expect(tailTokens).toBeGreaterThan(1000);
    expect(tailTokens).toBeLessThanOrEqual(
      DEFAULT_TAIL_COMPACTION_SHAPE.tailBudgetTokens + 50,
    );
    const liveBodies = result.output
      .flatMap((t) =>
        t.content.flatMap((b) => {
          if (b.type === "tool_result")
            return b.content.map((c) => (c.type === "text" ? c.text : ""));
          return [];
        }),
      )
      .join("\n");
    expect(liveBodies).not.toContain(dump);
    expect(JSON.stringify(result.output)).toContain(screenshot);
    expect(estimateContextTokens(result.output)).toBeLessThan(
      compactionThresholdFor(undefined),
    );
  });
});
