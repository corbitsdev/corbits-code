import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPruningCompactor } from "./compactor.js";
import { condenseTurns } from "./summarizer.js";
import { HANDOFF_LATEST_KEY } from "./compaction-handoff.js";
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

function handoffFileText(result: {
  blobs?: { key: string; bytes: Uint8Array }[];
}): string {
  const blob = result.blobs?.find((b) => b.key === HANDOFF_LATEST_KEY);
  if (blob === undefined) return "";
  return new TextDecoder().decode(blob.bytes);
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

  test("uppercase HTTP URL in user text is lifted into exactNames", () => {
    const facts = extractContinuationFacts([
      textTurn("user", "Call HTTP://API.COM next"),
    ]);
    expect(facts.exactNames).toContain("HTTP://API.COM");
  });

  test("sentence-final period is not part of a user-text URL", () => {
    const facts = extractContinuationFacts([
      textTurn("user", "Call HTTP://API.COM."),
    ]);
    expect(facts.exactNames).toContain("HTTP://API.COM");
    expect(facts.exactNames).not.toContain("HTTP://API.COM.");
    expect(
      verifyCompactionSummary("Call api.com", facts).misses.some(
        (m) => m.kind === "exactName",
      ),
    ).toBe(false);
  });

  test("comma glue is not part of a user-text URL", () => {
    const facts = extractContinuationFacts([
      textTurn("user", "Call HTTP://API.COM, then retry"),
    ]);
    expect(facts.exactNames).toContain("HTTP://API.COM");
    expect(facts.exactNames).not.toContain("HTTP://API.COM,");
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

  test("auth as a goal token does not match authored, author, preauth, or pre-auth", () => {
    const facts = extractContinuationFacts([textTurn("user", "Fix auth now")]);
    for (const summary of [
      "The authored notes: next step module plan is set.",
      "The author notes: next step module plan is set.",
      "The preauth notes: next step module plan is set.",
      "The pre-auth notes: next step module plan is set.",
    ]) {
      const report = verifyCompactionSummary(summary, facts);
      expect(report.supported).toBe(false);
      expect(report.misses.some((m) => m.kind === "goal")).toBe(true);
    }
  });

  test("trailing period on a goal needle does not miss an unpunctuated summary", () => {
    const facts = extractContinuationFacts([textTurn("user", "Fix auth now.")]);
    const report = verifyCompactionSummary("Fix auth now", facts);
    expect(report.misses.some((m) => m.kind === "goal")).toBe(false);
  });

  test("trailing period on a constraint needle does not miss an unpunctuated summary", () => {
    const facts = {
      goal: "Fix auth now",
      constraints: ["Never use emojis."],
      nextAction: "",
      verification: [],
      blockers: [],
      exactNames: [],
    };
    const report = verifyCompactionSummary(
      "Fix auth now. Never use emojis",
      facts,
    );
    expect(report.misses.some((m) => m.kind === "constraint")).toBe(false);
  });

  test("denying failure while errors were dropped is a contradiction", () => {
    const facts = extractContinuationFacts(droppedTurns());
    const report = verifyCompactionSummary(
      "Auth migration done. No errors remain.",
      facts,
    );
    expect(report.misses.some((m) => m.kind === "contradiction")).toBe(true);
  });

  test("a half-overlap paraphrase does not cover the standing goal", () => {
    const facts = extractContinuationFacts(droppedTurns());
    const report = verifyCompactionSummary(
      "The module tokens migrate elsewhere on schedule.",
      facts,
    );
    expect(report.misses.some((m) => m.kind === "goal")).toBe(true);
  });

  test("oauth.ts does not cover src/auth.ts", () => {
    const facts = extractContinuationFacts([
      textTurn("user", "Fix auth now"),
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
        timestamp: 2,
      },
    ]);
    const report = verifyCompactionSummary(
      "Fix auth now. Read oauth.ts next.",
      facts,
    );
    expect(report.misses.some((m) => m.kind === "exactName")).toBe(true);
    expect(report.misses.some((m) => m.detail === "src/auth.ts")).toBe(true);
  });

  test("tsconfig.json does not cover config.json", () => {
    const facts = extractContinuationFacts([
      textTurn("user", "Fix auth now"),
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "c1",
            name: "read_file",
            arguments: { path: "src/config.json" },
          },
        ],
        timestamp: 2,
      },
    ]);
    const report = verifyCompactionSummary(
      "Fix auth now. Updated tsconfig.json.",
      facts,
    );
    expect(report.misses.some((m) => m.kind === "exactName")).toBe(true);
    expect(report.misses.some((m) => m.detail === "src/config.json")).toBe(
      true,
    );
  });

  test("myapi.com does not cover hostname api.com", () => {
    const facts = extractContinuationFacts([
      textTurn("user", "Fix auth now"),
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "c1",
            name: "web_fetch",
            arguments: { url: "https://api.com/v1" },
          },
        ],
        timestamp: 2,
      },
    ]);
    const report = verifyCompactionSummary(
      "Fix auth now. Called myapi.com.",
      facts,
    );
    expect(report.misses.some((m) => m.kind === "exactName")).toBe(true);
    expect(report.misses.some((m) => m.detail === "https://api.com/v1")).toBe(
      true,
    );
  });

  test("dotted names are whole tokens so suffixes and prefixes do not cover", () => {
    const cases: {
      tool: string;
      args: Record<string, string>;
      summary: string;
      detail: string;
    }[] = [
      {
        tool: "read_file",
        args: { path: "src/config.ts" },
        summary: "Fix auth now. Updated vite.config.ts.",
        detail: "src/config.ts",
      },
      {
        tool: "read_file",
        args: { path: "src/test.ts" },
        summary: "Fix auth now. Updated auth.test.ts.",
        detail: "src/test.ts",
      },
      {
        tool: "read_file",
        args: { path: "src/auth.ts" },
        summary: "Fix auth now. Updated foo.auth.ts.",
        detail: "src/auth.ts",
      },
      {
        tool: "read_file",
        args: { path: "src/auth.ts" },
        summary: "Fix auth now. Kept auth.ts.bak.",
        detail: "src/auth.ts",
      },
      {
        tool: "web_fetch",
        args: { url: "https://api.com/v1" },
        summary: "Fix auth now. Called www.api.com.",
        detail: "https://api.com/v1",
      },
    ];
    for (const { tool, args, summary, detail } of cases) {
      const facts = extractContinuationFacts([
        textTurn("user", "Fix auth now"),
        {
          role: "assistant",
          content: [
            {
              type: "tool_call",
              id: "c1",
              name: tool,
              arguments: args,
            },
          ],
          timestamp: 2,
        },
      ]);
      const report = verifyCompactionSummary(summary, facts);
      expect(report.misses.some((m) => m.kind === "exactName")).toBe(true);
      expect(report.misses.some((m) => m.detail === detail)).toBe(true);
    }
  });

  test("basename in a path still covers the exact name", () => {
    const facts = extractContinuationFacts([
      textTurn("user", "Fix auth now"),
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
        timestamp: 2,
      },
    ]);
    const report = verifyCompactionSummary(
      "Fix auth now. Read auth.ts next.",
      facts,
    );
    expect(report.misses.some((m) => m.kind === "exactName")).toBe(false);
  });

  test("http/client.ts is covered by basename client.ts", () => {
    for (const filePath of ["http/client.ts", "HTTP/Client.ts"]) {
      const facts = extractContinuationFacts([
        textTurn("user", "Fix auth now"),
        {
          role: "assistant",
          content: [
            {
              type: "tool_call",
              id: "c1",
              name: "read_file",
              arguments: { path: filePath },
            },
          ],
          timestamp: 2,
        },
      ]);
      const report = verifyCompactionSummary(
        "Fix auth now. Read client.ts next.",
        facts,
      );
      expect(report.misses.some((m) => m.kind === "exactName")).toBe(false);
    }
  });

  test("uppercase HTTP URL scores hostname case-insensitively", () => {
    const facts = extractContinuationFacts([
      textTurn("user", "Fix auth now"),
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "c1",
            name: "web_fetch",
            arguments: { url: "HTTP://API.COM/v1" },
          },
        ],
        timestamp: 2,
      },
    ]);
    expect(
      verifyCompactionSummary(
        "Fix auth now. Called api.com.",
        facts,
      ).misses.some((m) => m.kind === "exactName"),
    ).toBe(false);
    expect(
      verifyCompactionSummary(
        "Fix auth now. Hit endpoint v1.",
        facts,
      ).misses.some((m) => m.kind === "exactName"),
    ).toBe(true);
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
    const facts = {
      goal: "Migrate the auth module to opaque tokens",
      constraints: [
        "Never use emojis in the handoff.",
        "Always keep the public API stable.",
      ],
      nextAction: "Fix the token refresh assertion next.",
      verification: ["bun run test auth", "bun run check"],
      blockers: ["token refresh assertion failed", "ECONNREFUSED on staging"],
      exactNames: ["src/auth.ts", "packages/runtime/config.json"],
    };
    const summary =
      "Migrating auth to opaque tokens. Read src/auth.ts, ran bun run test " +
      "auth; the token refresh assertion failed. Never use emojis in the " +
      "handoff. Fix the token refresh assertion next.";
    const misses = verifyCompactionSummary(summary, facts).misses;
    const kinds = misses.map((m) => m.kind);
    expect(kinds).toContain("constraint");
    expect(kinds).toContain("blocker");
    expect(kinds).toContain("verification");
    expect(kinds).toContain("exactName");
    expect(kinds).not.toContain("goal");
    expect(kinds).not.toContain("nextAction");
    const repaired = repairSummary(summary, facts, misses);
    const repair = repaired.slice(repaired.indexOf(VERIFY_REPAIR_HEADING));
    expect(repair).toContain("Always keep the public API stable.");
    expect(repair).not.toContain("Never use emojis");
    expect(repair).toContain("ECONNREFUSED on staging");
    expect(repair).not.toContain("token refresh assertion failed");
    expect(repair).toContain("bun run check");
    expect(repair).not.toContain("bun run test auth");
    expect(repair).toContain("packages/runtime/config.json");
    expect(repair).not.toContain("src/auth.ts");
    expect(repair).not.toContain("Goal:");
    expect(repair).not.toContain("Next:");
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
  test("verify signal holds after five lossy folds", async () => {
    let priorFile: string | undefined;
    const compactor = createPruningCompactor({
      keepRecentTurns: 2,
      summaryMaxChars: 4000,
      summarize: async () => "Work continues. Next: fix tests.",
      readPriorHandoff: async () => priorFile,
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
      const file = handoffFileText(result);
      // The thin live spine does not carry next-action / blocker text; the
      // fat handoff file does. Verify repair writes those into the narrative
      // that the file persists, and later folds re-read it.
      expect(file).toContain("refresh assertion");
      priorFile = file;
      turns = [
        ...result.output,
        textTurn("user", `follow-up ${fold}`),
        textTurn("assistant", `progress note ${fold}`),
      ];
    }
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
    let priorFile: string | undefined;
    const inner = createPruningCompactor({
      keepRecentTurns: 2,
      summaryMaxChars: 4000,
      summarize: async () => "Work continues. Next: fix tests.",
      readPriorHandoff: async () => priorFile,
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
    const firstFile = handoffFileText(first);
    expect(firstFile).toContain("refresh assertion");
    priorFile = firstFile;

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
    expect(handoffFileText(second)).toContain("refresh assertion");
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
