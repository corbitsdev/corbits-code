import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALLOWED_TAG_KEYS,
  RING_CAPACITY,
  clear,
  end,
  mark,
  snapshot,
  start,
  type PerfSpan,
} from "./index.js";
import {
  DUMP_SPAN_KEYS,
  buildDump,
  collectNonAllowlistedTagKeys,
  dumpSpans,
  serializeSpan,
} from "./dump.js";
import {
  rollupByPhase,
  rollupByTurn,
  sessionTotals,
  spanDurationNs,
} from "./rollup.js";

// The span store is process-wide, so a perf test cannot assume the tests that
// ran before it in this process left it empty. Reset on both edges.
beforeEach(() => {
  clear();
});

afterEach(() => {
  clear();
});

const ALLOWED_TAG_KEY_SET: ReadonlySet<string> = new Set(ALLOWED_TAG_KEYS);
const DUMP_SPAN_KEY_SET: ReadonlySet<string> = new Set(DUMP_SPAN_KEYS);

/** Build a completed span with fixed times (no live clock). */
function span( partial: {
  id: string;
  name: PerfSpan["name"];
  parentId?: string;
  startNs: bigint;
  endNs?: bigint;
  tags?: PerfSpan["tags"];
}): PerfSpan {
  const s: PerfSpan = {
    id: partial.id,
    name: partial.name,
    startNs: partial.startNs,
  };
  if (partial.parentId !== undefined) s.parentId = partial.parentId;
  if (partial.endNs !== undefined) s.endNs = partial.endNs;
  if (partial.tags !== undefined) s.tags = partial.tags;
  return s;
}

/**
 * Nested tree:
 *   turn t1
 *     inference i1          1000ns
 *       inference.ttft      200ns
 *       inference.stream    800ns
 *     tool k1               300ns
 *     tool k2               100ns
 */
function nestedTurnFixture(): PerfSpan[] {
  return [
    span({ id: "t1", name: "turn", startNs: 0n, endNs: 2000n }),
    span({
      id: "i1",
      name: "inference",
      parentId: "t1",
      startNs: 100n,
      endNs: 1100n,
    }),
    span({
      id: "ttft1",
      name: "inference.ttft",
      parentId: "i1",
      startNs: 100n,
      endNs: 300n,
    }),
    span({
      id: "stream1",
      name: "inference.stream",
      parentId: "i1",
      startNs: 300n,
      endNs: 1100n,
    }),
    span({
      id: "k1",
      name: "tool",
      parentId: "t1",
      startNs: 1200n,
      endNs: 1500n,
      tags: { tool_id: "read" },
    }),
    span({
      id: "k2",
      name: "tool",
      parentId: "t1",
      startNs: 1600n,
      endNs: 1700n,
      tags: { tool_id: "edit" },
    }),
  ];
}

describe("spanDurationNs", () => {
  test("returns end - start for completed spans", () => {
    expect(spanDurationNs(span({ id: "a", name: "tool", startNs: 10n, endNs: 40n }))).toBe(30);
  });

  test("returns undefined for open spans", () => {
    expect(spanDurationNs(span({ id: "a", name: "tool", startNs: 10n }))).toBeUndefined();
  });
});

describe("rollupByPhase", () => {
  test("aggregates total, count, and percentiles per phase", () => {
    const spans = nestedTurnFixture();
    const phases = rollupByPhase(spans);
    const byName = Object.fromEntries(phases.map((p) => [p.name, p]));

    expect(byName.turn).toMatchObject({ count: 1, openCount: 0, totalNs: 2000 });
    expect(byName.inference).toMatchObject({ count: 1, totalNs: 1000 });
    expect(byName["inference.ttft"]).toMatchObject({ count: 1, totalNs: 200 });
    expect(byName["inference.stream"]).toMatchObject({ count: 1, totalNs: 800 });
    expect(byName.tool).toMatchObject({ count: 2, totalNs: 400, p50Ns: 100, p95Ns: 300 });
  });

  test("open spans count but do not contribute to duration stats", () => {
    const spans: PerfSpan[] = [
      span({ id: "a", name: "tool", startNs: 0n, endNs: 100n }),
      span({ id: "b", name: "tool", startNs: 0n }), // open
    ];
    const tool = rollupByPhase(spans).find((p) => p.name === "tool")!;
    expect(tool.count).toBe(2);
    expect(tool.openCount).toBe(1);
    expect(tool.totalNs).toBe(100);
    expect(tool.p50Ns).toBe(100);
  });

  test("empty snapshot yields empty phase list", () => {
    expect(rollupByPhase([])).toEqual([]);
  });
});

describe("rollupByTurn", () => {
  test("attributes nested inference, ttft, stream, and tools under a turn", () => {
    const turns = rollupByTurn(nestedTurnFixture());
    expect(turns).toHaveLength(1);
    expect(turns[0]).toEqual({
      turnId: "t1",
      turnNs: 2000,
      open: false,
      inferenceNs: 1000,
      toolNs: 400,
      ttftNs: 200,
      streamNs: 800,
      toolCount: 2,
    });
  });

  test("multiple turns stay independent", () => {
    const spans: PerfSpan[] = [
      span({ id: "t1", name: "turn", startNs: 0n, endNs: 1000n }),
      span({
        id: "i1",
        name: "inference",
        parentId: "t1",
        startNs: 0n,
        endNs: 500n,
      }),
      span({
        id: "ttft1",
        name: "inference.ttft",
        parentId: "i1",
        startNs: 0n,
        endNs: 100n,
      }),
      span({
        id: "stream1",
        name: "inference.stream",
        parentId: "i1",
        startNs: 100n,
        endNs: 500n,
      }),
      span({ id: "t2", name: "turn", startNs: 2000n, endNs: 3500n }),
      span({
        id: "i2",
        name: "inference",
        parentId: "t2",
        startNs: 2000n,
        endNs: 3000n,
      }),
      span({
        id: "ttft2",
        name: "inference.ttft",
        parentId: "i2",
        startNs: 2000n,
        endNs: 2200n,
      }),
      span({
        id: "stream2",
        name: "inference.stream",
        parentId: "i2",
        startNs: 2200n,
        endNs: 3000n,
      }),
      span({
        id: "k2",
        name: "tool",
        parentId: "t2",
        startNs: 3100n,
        endNs: 3400n,
      }),
    ];

    const turns = rollupByTurn(spans);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.turnId).toBe("t1");
    expect(turns[0]!.inferenceNs).toBe(500);
    expect(turns[0]!.ttftNs).toBe(100);
    expect(turns[0]!.streamNs).toBe(400);
    expect(turns[0]!.toolCount).toBe(0);
    expect(turns[1]!.turnId).toBe("t2");
    expect(turns[1]!.inferenceNs).toBe(1000);
    expect(turns[1]!.ttftNs).toBe(200);
    expect(turns[1]!.streamNs).toBe(800);
    expect(turns[1]!.toolNs).toBe(300);
    expect(turns[1]!.toolCount).toBe(1);
  });

  test("open turn is flagged and turnNs is 0", () => {
    const turns = rollupByTurn([
      span({ id: "t1", name: "turn", startNs: 0n }),
      span({
        id: "i1",
        name: "inference",
        parentId: "t1",
        startNs: 0n,
        endNs: 50n,
      }),
    ]);
    expect(turns[0]).toMatchObject({ open: true, turnNs: 0, inferenceNs: 50 });
  });
});

describe("sessionTotals", () => {
  test("sums across turns and reports TTFT vs stream share", () => {
    const spans: PerfSpan[] = [
      span({ id: "t1", name: "turn", startNs: 0n, endNs: 1000n }),
      span({
        id: "i1",
        name: "inference",
        parentId: "t1",
        startNs: 0n,
        endNs: 500n,
      }),
      span({
        id: "ttft1",
        name: "inference.ttft",
        parentId: "i1",
        startNs: 0n,
        endNs: 100n,
      }),
      span({
        id: "stream1",
        name: "inference.stream",
        parentId: "i1",
        startNs: 100n,
        endNs: 500n,
      }),
      span({ id: "t2", name: "turn", startNs: 2000n, endNs: 3000n }),
      span({
        id: "i2",
        name: "inference",
        parentId: "t2",
        startNs: 2000n,
        endNs: 2800n,
      }),
      span({
        id: "ttft2",
        name: "inference.ttft",
        parentId: "i2",
        startNs: 2000n,
        endNs: 2300n,
      }),
      span({
        id: "stream2",
        name: "inference.stream",
        parentId: "i2",
        startNs: 2300n,
        endNs: 2800n,
      }),
      span({
        id: "k1",
        name: "tool",
        parentId: "t2",
        startNs: 2800n,
        endNs: 2900n,
      }),
    ];

    const totals = sessionTotals(spans);
    expect(totals.turnCount).toBe(2);
    expect(totals.completedTurnCount).toBe(2);
    expect(totals.totalTurnNs).toBe(2000);
    expect(totals.totalInferenceNs).toBe(1300);
    expect(totals.totalTtftNs).toBe(400); // 100 + 300
    expect(totals.totalStreamNs).toBe(900); // 400 + 500
    expect(totals.totalToolNs).toBe(100);
    expect(totals.totalToolCount).toBe(1);
    expect(totals.ttftShare).toBeCloseTo(400 / 1300, 10);
    expect(totals.streamShare).toBeCloseTo(900 / 1300, 10);
    expect(totals.ttftShare + totals.streamShare).toBeCloseTo(1, 10);
  });

  test("zero TTFT and stream yields zero shares", () => {
    const totals = sessionTotals([
      span({ id: "t1", name: "turn", startNs: 0n, endNs: 10n }),
    ]);
    expect(totals.ttftShare).toBe(0);
    expect(totals.streamShare).toBe(0);
  });

  test("empty snapshot yields zeros", () => {
    expect(sessionTotals([])).toEqual({
      turnCount: 0,
      completedTurnCount: 0,
      totalTurnNs: 0,
      totalInferenceNs: 0,
      totalToolNs: 0,
      totalTtftNs: 0,
      totalStreamNs: 0,
      totalToolCount: 0,
      ttftShare: 0,
      streamShare: 0,
    });
  });
});

describe("dumpSpans", () => {
  test("writes compact JSON beside the given dir and returns the path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "perftrace-dump-"));
    try {
      const spans = nestedTurnFixture();
      const path = await dumpSpans(spans, { dir, sessionId: "sess-abc" });
      expect(path).toBe(join(dir, "perftrace-sess-abc.json"));

      const raw = await readFile(path, "utf8");
      const dump = JSON.parse(raw);
      expect(dump.version).toBe(1);
      expect(dump.sessionId).toBe("sess-abc");
      expect(dump.spanCount).toBe(spans.length);
      expect(dump.rollup.byTurn).toHaveLength(1);
      expect(dump.rollup.session.totalToolCount).toBe(2);
      expect(dump.spans).toHaveLength(spans.length);
      // Compact: single trailing newline, no pretty indent.
      expect(raw.endsWith("\n")).toBe(true);
      expect(raw.trimStart().startsWith("{")).toBe(true);
      expect(raw.includes("\n  ")).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects path-like session ids", async () => {
    await expect(
      dumpSpans([], { dir: "/tmp", sessionId: "../etc/passwd" }),
    ).rejects.toThrow(/sessionId/);
  });

  test("serializes open spans without endNs", () => {
    const s = serializeSpan(span({ id: "x", name: "session", startNs: 42n }));
    expect(s.open).toBe(true);
    expect(s.endNs).toBeUndefined();
    expect(s.startNs).toBe("42");
  });
});

describe("privacy fixture", () => {
  test("dump contains only allowlisted span fields and tag keys", async () => {
    // Live ring path: tags go through sanitizeTags on start/end.
    const turnId = start("turn", {
      tags: {
        turn_id: "t-1",
        // forbidden — must never appear
        prompt: "system: you are a helpful assistant",
        path: "/Users/me/secret/repo/src/main.ts",
        error: "ENOENT: no such file",
      },
    });
    const infId = start("inference", {
      parentId: turnId,
      tags: {
        provider_id: "openai",
        model_id: "gpt-5.4",
        completion: "sure, here is the code",
      },
    });
    end(infId, { input_tokens: 10, output_tokens: 5, message: "drop me" });
    const toolId = start("tool", {
      parentId: turnId,
      tags: { tool_id: "shell", tool_args: "rm -rf /" },
    });
    end(toolId, { count: 1 });
    end(turnId);

    // Also inject a hand-built span that pretends to carry free text, to prove
    // serializeSpan re-sanitizes even when the in-memory shape is dirty.
    const dirty = {
      id: "dirty",
      name: "adapter.transport" as const,
      startNs: 1n,
      endNs: 2n,
      tags: {
        transport: "http_sse" as const,
        prompt: "should never dump",
        stack: "Error\n    at foo",
      },
    } as unknown as PerfSpan;

    const spans = [...snapshot(), dirty];
    const dump = buildDump(spans, "privacy-fixture", "2026-04-08T00:00:00.000Z");

    // Top-level keys are a fixed allowlist.
    expect(Object.keys(dump).sort()).toEqual(
      ["openCount", "rollup", "sessionId", "spanCount", "spans", "version", "writtenAt"].sort(),
    );

    // No free-text substrings anywhere in the serialized dump.
    const json = JSON.stringify(dump);
    for (const banned of [
      "helpful assistant",
      "/Users/me",
      "ENOENT",
      "sure, here is the code",
      "rm -rf",
      "should never dump",
      "at foo",
      "drop me",
    ]) {
      expect(json.includes(banned)).toBe(false);
    }

    // Every tag key on every span is allowlisted.
    expect(collectNonAllowlistedTagKeys(dump)).toEqual([]);
    for (const s of dump.spans) {
      for (const key of Object.keys(s)) {
        expect(DUMP_SPAN_KEY_SET.has(key)).toBe(true);
      }
      if (s.tags !== undefined) {
        for (const key of Object.keys(s.tags)) {
          expect(ALLOWED_TAG_KEY_SET.has(key)).toBe(true);
        }
      }
    }

    // Allowlisted tags that were supplied are retained.
    const tool = dump.spans.find((s) => s.name === "tool");
    expect(tool?.tags).toEqual({ tool_id: "shell", count: 1 });
    const transport = dump.spans.find((s) => s.id === "dirty");
    expect(transport?.tags).toEqual({ transport: "http_sse" });
  });
});

describe("edge: ring eviction and open spans in snapshot", () => {
  test("rollup tolerates more than RING_CAPACITY completed spans", () => {
    for (let i = 0; i < RING_CAPACITY + 25; i += 1) {
      mark("tool", { tags: { count: i } });
    }
    const spans = snapshot();
    expect(spans).toHaveLength(RING_CAPACITY);

    const phases = rollupByPhase(spans);
    const tool = phases.find((p) => p.name === "tool")!;
    expect(tool.count).toBe(RING_CAPACITY);
    // Durations of mark() are zero (startNs === endNs).
    expect(tool.totalNs).toBe(0);
  });

  test("sessionTotals falls back to flat phase sums when turn roots are gone", () => {
    // Orphan inference + ttft after a hypothetical ring eviction of the turn.
    const spans: PerfSpan[] = [
      span({
        id: "i1",
        name: "inference",
        parentId: "missing-turn",
        startNs: 0n,
        endNs: 500n,
      }),
      span({
        id: "ttft1",
        name: "inference.ttft",
        parentId: "i1",
        startNs: 0n,
        endNs: 100n,
      }),
      span({
        id: "stream1",
        name: "inference.stream",
        parentId: "i1",
        startNs: 100n,
        endNs: 500n,
      }),
    ];
    const totals = sessionTotals(spans);
    expect(totals.turnCount).toBe(0);
    expect(totals.totalInferenceNs).toBe(500);
    expect(totals.totalTtftNs).toBe(100);
    expect(totals.totalStreamNs).toBe(400);
    expect(totals.ttftShare).toBeCloseTo(0.2, 10);
  });
});
