import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPruningCompactor } from "./compactor.js";
import { condenseTurns } from "./summarizer.js";
import {
  createCompactionArchive,
  wrapCompactorWithCompletenessGate,
} from "./compaction-archive.js";
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

  test("auth as a goal token does not match authored, author, or preauth", () => {
    const facts = extractContinuationFacts([textTurn("user", "Fix auth now")]);
    for (const summary of [
      "The authored notes: next step module plan is set.",
      "The author notes: next step module plan is set.",
      "The preauth notes: next step module plan is set.",
    ]) {
      const report = verifyCompactionSummary(summary, facts);
      expect(report.supported).toBe(false);
      expect(report.misses.some((m) => m.kind === "goal")).toBe(true);
    }
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
    expect(outcome.misses.some((m) => m.kind === "exactName")).toBe(true);
  });

  test("a roomy cap repairs and keeps the exact-name basename", () => {
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
    const outcome = verifyOrRepair(
      "Fix auth now. Work continues.",
      facts,
      4000,
    );
    expect(outcome.aborted).toBe(false);
    expect(outcome.repaired).toBe(true);
    expect(outcome.summary).toContain("exact-file.ts");
  });

  test("a constraint-only residual after a sliced repair aborts", () => {
    const facts = extractContinuationFacts([
      textTurn("user", "Fix auth now"),
      textTurn("assistant", "Working on auth now."),
      textTurn("user", "Do not commit generated artifacts ever."),
      textTurn("assistant", "Working on auth now."),
    ]);
    expect(
      facts.constraints.some((c) => c.includes("generated artifacts")),
    ).toBe(true);
    const summary = "Fix auth now. Working on auth now.";
    const misses = verifyCompactionSummary(summary, facts).misses;
    expect(misses.map((m) => m.kind)).toEqual(["constraint"]);
    const full = repairSummary(summary, facts, misses);
    const cap = full.indexOf("Constraints:");
    expect(cap).toBeGreaterThan(0);
    const outcome = verifyOrRepair(summary, facts, cap);
    expect(outcome.aborted).toBe(true);
    expect(outcome.repaired).toBe(false);
    expect(outcome.misses.some((m) => m.kind === "constraint")).toBe(true);
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

  test("repair lines are goal, next, exact names, then the rest", () => {
    const facts = extractContinuationFacts(droppedTurns());
    const misses = verifyCompactionSummary("Work continues.", facts).misses;
    const repaired = repairSummary("Work continues.", facts, misses);
    const goalAt = repaired.indexOf("Goal:");
    const nextAt = repaired.indexOf("Next:");
    const exactAt = repaired.indexOf("Exact references:");
    const blockersAt = repaired.indexOf("Open blockers:");
    const ranAt = repaired.indexOf("Ran:");
    expect(goalAt).toBeGreaterThan(-1);
    expect(nextAt).toBeGreaterThan(goalAt);
    expect(exactAt).toBeGreaterThan(nextAt);
    expect(blockersAt).toBeGreaterThan(exactAt);
    expect(ranAt).toBeGreaterThan(blockersAt);
  });

  test("a tight cap keeps goal, next, and names before aborting on the tail", () => {
    const facts = extractContinuationFacts(droppedTurns());
    const misses = verifyCompactionSummary("Work continues.", facts).misses;
    const full = repairSummary("Work continues.", facts, misses);
    const cap = full.indexOf("Open blockers:");
    expect(cap).toBeGreaterThan(0);
    const outcome = verifyOrRepair("Work continues.", facts, cap);
    expect(outcome.aborted).toBe(true);
    const kinds = outcome.misses.map((m) => m.kind);
    expect(kinds).not.toContain("goal");
    expect(kinds).not.toContain("nextAction");
    expect(kinds).not.toContain("exactName");
    expect(kinds).toContain("verification");
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

describe("completeness gate plus verify repair", () => {
  function memoryArchive() {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "compaction-verify-gate-"),
    );
    const blobs = new Map<string, Uint8Array>();
    const archive = createCompactionArchive({
      sessionId: "sess-verify-gate",
      contextDir: dir,
      writeBlob: async (key, bytes) => {
        blobs.set(key, bytes);
      },
      readBlob: async (key) => {
        const bytes = blobs.get(key);
        if (bytes === undefined) throw new Error(`missing ${key}`);
        return bytes;
      },
    });
    return archive;
  }

  async function archiveTurns(
    archive: ReturnType<typeof createCompactionArchive>,
    turns: readonly ConversationTurn[],
  ): Promise<void> {
    for (const turn of turns) {
      for (const block of turn.content) {
        if (block.type === "text" && block.text.length > 0) {
          await archive.recordAuthorizedPayload({
            kind: turn.role === "assistant" ? "assistant_text" : "user_message",
            payload: block.text,
          });
        } else if (block.type === "tool_call") {
          await archive.recordAuthorizedPayload({
            kind: "tool_args",
            payload: { name: block.name, arguments: block.arguments },
            callId: block.id,
          });
        } else if (block.type === "tool_result") {
          const text = block.content
            .flatMap((c) => (c.type === "text" ? [c.text] : []))
            .join("");
          await archive.recordAuthorizedPayload({
            kind: "tool_result",
            payload: text,
            callId: block.callId,
          });
        }
      }
    }
  }

  test("two lossy folds through the gate keep facts via adopted handoffs", async () => {
    const archive = memoryArchive();
    const inner = createPruningCompactor({
      keepRecentTurns: 2,
      summaryMaxChars: 4000,
      summarize: async () => "Work continues. Next: fix tests.",
    });
    const wrapped = wrapCompactorWithCompletenessGate(inner, archive);
    let turns: ConversationTurn[] = [
      ...droppedTurns(),
      textTurn("user", "recent ask"),
      textTurn("assistant", "recent reply"),
    ];
    await archiveTurns(archive, turns);

    const first = await wrapped.apply(turns, mockStrategyCtx);
    expect(first.record.reason).not.toBe("incomplete-evidence-archive");
    expect(first.record.reason).not.toBe(
      "verify failed — keeping prior context",
    );
    expect(first.record.decisions).toMatchObject({ verifyRepaired: 1 });
    const handoffs = (await archive.listOccurrences()).filter(
      (occurrence) => occurrence.provenance === "compaction-handoff",
    );
    expect(handoffs.length).toBeGreaterThan(0);
    expect(allText(first.output)).toContain("opaque tokens");
    expect(allText(first.output)).toContain("auth.ts");

    const followUp = [
      textTurn("user", "follow-up after first fold"),
      textTurn("assistant", "progress note after first fold"),
    ];
    await archiveTurns(archive, followUp);
    turns = [...first.output, ...followUp];

    const second = await wrapped.apply(turns, mockStrategyCtx);
    expect(second.record.reason).not.toBe("incomplete-evidence-archive");
    expect(second.record.reason).not.toBe(
      "verify failed — keeping prior context",
    );
    expect(allText(second.output)).toContain("opaque tokens");
    expect(allText(second.output)).toContain("auth.ts");
    expect(allText(second.output)).toContain("refresh assertion");
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
