import { describe, test, expect } from "bun:test";
import { createPruningCompactor } from "./compactor.js";
import { condenseTurns } from "./summarizer.js";
import {
  extractContinuationFacts,
  repairSummary,
  verifyCompactionSummary,
  verifyOrRepair,
  VERIFY_REPAIR_HEADING,
} from "./compaction-verify.js";
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
  extra: Partial<ConversationTurn> = {},
): ConversationTurn {
  return {
    role,
    content: [{ type: "text", text }],
    timestamp: Date.now(),
    ...extra,
  };
}

function allText(turns: ConversationTurn[]): string {
  return turns
    .flatMap((t) =>
      t.content.filter((b) => b.type === "text").map((b) => b.text),
    )
    .join("\n");
}

// A dropped region with a standing goal, an exact path, a verification
// command, and an unresolved failure.
function droppedTurns(): ConversationTurn[] {
  return [
    textTurn("user", "Migrate the auth module to opaque tokens in src/auth.ts"),
    textTurn("assistant", "Reading the handler first."),
    {
      role: "assistant",
      content: [
        {
          type: "tool_call",
          id: "c1",
          name: "read_file",
          arguments: { path: "src/auth.ts" },
        },
      ],
      timestamp: 3,
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          callId: "c1",
          content: [{ type: "text", text: "handler source" }],
        },
      ],
      timestamp: 4,
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool_call",
          id: "c2",
          name: "run_shell",
          arguments: { command: "bun run test auth" },
        },
      ],
      timestamp: 5,
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          callId: "c2",
          isError: true,
          content: [{ type: "text", text: "token refresh assertion failed" }],
        },
      ],
      timestamp: 6,
    },
    textTurn("assistant", "Fix the token refresh assertion next."),
  ];
}

describe("extractContinuationFacts", () => {
  test("lifts goal, exact names, verification, and blockers", () => {
    const facts = extractContinuationFacts(droppedTurns());
    expect(facts.goal).toContain("opaque tokens");
    expect(facts.exactNames).toContain("src/auth.ts");
    expect(facts.verification).toContain("bun run test auth");
    expect(facts.blockers.join("\n")).toContain("refresh assertion failed");
    expect(facts.nextAction).toContain("refresh assertion next");
  });

  test("empty turns yield vacuous facts, never an abort", () => {
    const facts = extractContinuationFacts([]);
    const report = verifyCompactionSummary("anything", facts);
    expect(report.supported).toBe(true);
  });
});

describe("verifyCompactionSummary", () => {
  test("a faithful handoff is supported", () => {
    const facts = extractContinuationFacts(droppedTurns());
    const report = verifyCompactionSummary(
      "Migrating auth to opaque tokens. Read src/auth.ts, ran bun run test " +
        "auth; the token refresh assertion failed. Fix the token refresh " +
        "assertion next.",
      facts,
    );
    expect(report.supported).toBe(true);
    expect(report.misses).toEqual([]);
  });

  test("a lossy handoff misses the goal and the exact name", () => {
    const facts = extractContinuationFacts(droppedTurns());
    const report = verifyCompactionSummary(
      "Work continues. Next: fix tests.",
      facts,
    );
    expect(report.supported).toBe(false);
    const kinds = report.misses.map((m) => m.kind);
    expect(kinds).toContain("goal");
    expect(kinds).toContain("exactName");
  });

  test("auth as a goal token does not match authored", () => {
    const facts = extractContinuationFacts([textTurn("user", "Fix auth now")]);
    const report = verifyCompactionSummary(
      "The authored notes: next step module plan is set.",
      facts,
    );
    expect(report.supported).toBe(false);
    expect(report.misses.some((m) => m.kind === "goal")).toBe(true);
  });

  test("denying failure while errors were dropped is a contradiction", () => {
    const facts = extractContinuationFacts(droppedTurns());
    const report = verifyCompactionSummary(
      "Auth migration done. No errors remain.",
      facts,
    );
    expect(report.misses.some((m) => m.kind === "contradiction")).toBe(true);
  });
});

describe("verifyOrRepair", () => {
  test("repairs a lossy handoff instead of shipping it", () => {
    const facts = extractContinuationFacts(droppedTurns());
    const outcome = verifyOrRepair(
      "Work continues. Next: fix tests.",
      facts,
      4000,
    );
    expect(outcome.aborted).toBe(false);
    expect(outcome.repaired).toBe(true);
    expect(outcome.summary).toContain(VERIFY_REPAIR_HEADING);
    const rereport = verifyCompactionSummary(outcome.summary, facts);
    expect(rereport.misses.some((m) => m.kind === "goal")).toBe(false);
    expect(rereport.misses.some((m) => m.kind === "exactName")).toBe(false);
  });

  test("aborts a contradicting handoff instead of shipping a lie", () => {
    const facts = extractContinuationFacts(droppedTurns());
    const outcome = verifyOrRepair(
      "Auth migration done. No errors remain.",
      facts,
      4000,
    );
    expect(outcome.aborted).toBe(true);
    expect(outcome.repaired).toBe(false);
  });

  test("truncating repair that still misses exactName aborts", () => {
    const facts = extractContinuationFacts([
      textTurn("user", "Fix auth now"),
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "c1",
            name: "read_file",
            arguments: { path: "src/very-long-unique-path/exact-file.ts" },
          },
        ],
        timestamp: 2,
      },
    ]);
    const outcome = verifyOrRepair("Fix auth now. Work continues.", facts, 90);
    expect(outcome.aborted).toBe(true);
    expect(outcome.repaired).toBe(false);
    const shipped = verifyCompactionSummary(outcome.summary, facts);
    expect(shipped.misses.some((m) => m.kind === "exactName")).toBe(true);
  });

  test("repairSummary names only what the handoff missed", () => {
    const facts = extractContinuationFacts(droppedTurns());
    const repaired = repairSummary(
      "Migrating auth to opaque tokens in src/auth.ts.",
      facts,
      verifyCompactionSummary(
        "Migrating auth to opaque tokens in src/auth.ts.",
        facts,
      ).misses,
    );
    expect(repaired).toContain(VERIFY_REPAIR_HEADING);
  });
});

describe("pruning compactor verify pass", () => {
  test("a lossy fold is repaired: the goal and exact path survive", async () => {
    const compactor = createPruningCompactor({
      keepRecentTurns: 2,
      summaryMaxChars: 2000,
      summarize: async () => "Work continues. Next: fix tests.",
    });
    const turns: ConversationTurn[] = [
      ...droppedTurns(),
      textTurn("user", "recent ask"),
      textTurn("assistant", "recent reply"),
    ];
    const result = await compactor.apply(turns, mockStrategyCtx);
    expect(allText(result.output)).toContain("opaque tokens");
    expect(allText(result.output)).toContain("auth.ts");
    expect(result.record.decisions).toMatchObject({ verifyRepaired: 1 });
  });

  test("a contradicting fold aborts: prior context is kept", async () => {
    const compactor = createPruningCompactor({
      keepRecentTurns: 2,
      summaryMaxChars: 2000,
      summarize: async () => "Auth migration done. No errors remain.",
    });
    const turns: ConversationTurn[] = [
      ...droppedTurns(),
      textTurn("user", "recent ask"),
      textTurn("assistant", "recent reply"),
    ];
    const result = await compactor.apply(turns, mockStrategyCtx);
    expect(result.output).toBe(turns);
    expect(result.record.reason).toBe("verify failed — keeping prior context");
    expect(result.record.decisions).toMatchObject({ verifyAborted: 1 });
  });

  test("a faithful fold ships without repair markers", async () => {
    const compactor = createPruningCompactor({
      keepRecentTurns: 2,
      summaryMaxChars: 2000,
      summarize: async () =>
        "Migrating auth to opaque tokens. Read src/auth.ts, ran bun run " +
        "test auth; the token refresh assertion failed. Fix the token " +
        "refresh assertion next.",
    });
    const turns: ConversationTurn[] = [
      ...droppedTurns(),
      textTurn("user", "recent ask"),
      textTurn("assistant", "recent reply"),
    ];
    const result = await compactor.apply(turns, mockStrategyCtx);
    expect(allText(result.output)).not.toContain(VERIFY_REPAIR_HEADING);
    expect(result.record.decisions).not.toMatchObject({ verifyRepaired: 1 });
  });
});

describe("continuation facts survive many folds", () => {
  test("goal, exact path, and next action hold after five lossy folds", async () => {
    const compactor = createPruningCompactor({
      keepRecentTurns: 2,
      summaryMaxChars: 4000,
      summarize: async () => "Work continues. Next: fix tests.",
    });
    let turns: ConversationTurn[] = [
      ...droppedTurns(),
      textTurn("user", "recent ask"),
      textTurn("assistant", "recent reply"),
    ];
    for (let fold = 0; fold < 5; fold++) {
      const result = await compactor.apply(turns, mockStrategyCtx);
      // No fold may abort the eval: the lossy stub is repaired, not denied.
      expect(result.record.reason).not.toBe(
        "verify failed — keeping prior context",
      );
      turns = [
        ...result.output,
        textTurn("user", `follow-up ${fold}`),
        textTurn("assistant", `progress note ${fold}`),
      ];
    }
    const text = allText(turns);
    expect(text).toContain("opaque tokens");
    expect(text).toContain("auth.ts");
    expect(text).toContain("refresh assertion");
  });
});

describe("condenseTurns keep-set", () => {
  test("pins the standing goal ahead of the recency window", () => {
    const turns: ConversationTurn[] = [
      textTurn("user", "Standing goal: migrate auth to opaque tokens"),
      ...Array.from({ length: 8 }, (_, i) =>
        textTurn("user", `follow-up dump number ${i}`),
      ),
    ];
    const condensed = condenseTurns(turns);
    expect(condensed).toContain("opaque tokens");
    expect(condensed).toContain("Goal (first user message)");
  });
});
