import { describe, expect, test } from "bun:test";
import {
  attributionFromDump,
  attributionFromSpans,
  categoryShare,
  deserializeDumpSpan,
  formatAttributionReport,
  spansFromDumpJson,
} from "./attribution-report.js";
import { DUMP_VERSION, buildDump, serializeSpan } from "./dump.js";
import { MULTI_TOOL_TURN_GOLDEN, multiToolTurnFixture } from "./fixtures/multi-tool-turn.js";
import type { PerfSpan } from "./index.js";

function span(partial: {
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

describe("attributionFromSpans — multi-tool golden fixture", () => {
  test("exclusive shares match locked fixture durations", () => {
    const report = attributionFromSpans(multiToolTurnFixture());
    const g = MULTI_TOOL_TURN_GOLDEN;

    expect(report.session.turnCount).toBe(1);
    expect(report.session.completedTurnCount).toBe(1);
    expect(report.session.wallNs).toBe(g.turnNs);
    expect(report.session.toolCount).toBe(g.toolCount);

    const inf = categoryShare(report.session.categories, "inference");
    const tools = categoryShare(report.session.categories, "tools");
    const perm = categoryShare(report.session.categories, "permission.wait");
    const sub = categoryShare(report.session.categories, "subagent");
    const other = categoryShare(report.session.categories, "other");

    // turn 5000; inference 2000; tools 1200; permission 400 → other 1400
    expect(inf.ns).toBe(g.inferenceNs);
    expect(tools.ns).toBe(g.toolNs);
    expect(perm.ns).toBe(400);
    expect(sub.ns).toBe(0);
    expect(other.ns).toBe(1400);

    expect(inf.share).toBeCloseTo(2000 / 5000, 10);
    expect(tools.share).toBeCloseTo(1200 / 5000, 10);
    expect(perm.share).toBeCloseTo(400 / 5000, 10);
    expect(other.share).toBeCloseTo(1400 / 5000, 10);

    const shareSum = report.session.categories.reduce((a, c) => a + c.share, 0);
    expect(shareSum).toBeCloseTo(1, 10);
  });

  test("ttft vs stream split matches golden", () => {
    const report = attributionFromSpans(multiToolTurnFixture());
    const g = MULTI_TOOL_TURN_GOLDEN;
    expect(report.session.inference.ttftNs).toBe(g.ttftNs);
    expect(report.session.inference.streamNs).toBe(g.streamNs);
    expect(report.session.inference.ttftShare).toBeCloseTo(400 / 2000, 10);
    expect(report.session.inference.streamShare).toBeCloseTo(1600 / 2000, 10);
  });

  test("per-turn row mirrors session for single-turn fixture", () => {
    const report = attributionFromSpans(multiToolTurnFixture());
    expect(report.turns).toHaveLength(1);
    const t = report.turns[0]!;
    expect(t.turnId).toBe("t1");
    expect(t.turnNs).toBe(5000);
    expect(t.open).toBe(false);
    expect(categoryShare(t.categories, "inference").ns).toBe(2000);
    expect(categoryShare(t.categories, "tools").ns).toBe(1200);
    expect(categoryShare(t.categories, "permission.wait").ns).toBe(400);
    expect(categoryShare(t.categories, "other").ns).toBe(1400);
    expect(t.toolCount).toBe(2);
    expect(t.subagentCount).toBe(0);
  });
});

describe("attributionFromSpans — subagent + transport", () => {
  test("attributes subagent fanout and transport share of inference", () => {
    const spans: PerfSpan[] = [
      span({ id: "t1", name: "turn", startNs: 0n, endNs: 10_000n }),
      span({
        id: "i1",
        name: "inference",
        parentId: "t1",
        startNs: 0n,
        endNs: 4000n,
      }),
      span({
        id: "ttft1",
        name: "inference.ttft",
        parentId: "i1",
        startNs: 0n,
        endNs: 1000n,
      }),
      span({
        id: "stream1",
        name: "inference.stream",
        parentId: "i1",
        startNs: 1000n,
        endNs: 4000n,
      }),
      span({
        id: "tr1",
        name: "adapter.transport",
        parentId: "i1",
        startNs: 0n,
        endNs: 800n,
        tags: { transport: "http_sse" },
      }),
      span({
        id: "sa1",
        name: "subagent",
        parentId: "t1",
        startNs: 4000n,
        endNs: 7000n,
      }),
      span({
        id: "k1",
        name: "tool",
        parentId: "t1",
        startNs: 7000n,
        endNs: 8000n,
      }),
    ];

    const report = attributionFromSpans(spans);
    expect(categoryShare(report.session.categories, "inference").ns).toBe(4000);
    expect(categoryShare(report.session.categories, "subagent").ns).toBe(3000);
    expect(categoryShare(report.session.categories, "tools").ns).toBe(1000);
    // other = 10000 - 4000 - 1000 - 0 - 3000 = 2000
    expect(categoryShare(report.session.categories, "other").ns).toBe(2000);
    expect(report.session.subagentCount).toBe(1);
    expect(report.session.transportNs).toBe(800);
    expect(report.session.transportShareOfInference).toBeCloseTo(800 / 4000, 10);
    expect(report.session.open).toBe(false);
    expect(report.session.openPhases).toEqual([]);
  });

  test("nested exclusive under subagent does not double-count (share sum ≈ 1)", () => {
    // turn 10_000
    //   inference 2000 (top-level exclusive)
    //   subagent 6000 containing nested inference 2500 + tools 1500
    //   tool 1000 (sibling exclusive)
    // Exclusive: inference=2000, subagent=6000, tools=1000, other=1000
    // Nested under subagent must NOT add 2500+1500 into exclusive buckets.
    const spans: PerfSpan[] = [
      span({ id: "t1", name: "turn", startNs: 0n, endNs: 10_000n }),
      span({
        id: "i1",
        name: "inference",
        parentId: "t1",
        startNs: 0n,
        endNs: 2000n,
      }),
      span({
        id: "ttft1",
        name: "inference.ttft",
        parentId: "i1",
        startNs: 0n,
        endNs: 400n,
      }),
      span({
        id: "stream1",
        name: "inference.stream",
        parentId: "i1",
        startNs: 400n,
        endNs: 2000n,
      }),
      span({
        id: "sa1",
        name: "subagent",
        parentId: "t1",
        startNs: 2000n,
        endNs: 8000n,
      }),
      span({
        id: "sa_i1",
        name: "inference",
        parentId: "sa1",
        startNs: 2000n,
        endNs: 4500n,
      }),
      span({
        id: "sa_ttft",
        name: "inference.ttft",
        parentId: "sa_i1",
        startNs: 2000n,
        endNs: 2500n,
      }),
      span({
        id: "sa_stream",
        name: "inference.stream",
        parentId: "sa_i1",
        startNs: 2500n,
        endNs: 4500n,
      }),
      span({
        id: "sa_k1",
        name: "tool",
        parentId: "sa1",
        startNs: 4500n,
        endNs: 6000n,
      }),
      span({
        id: "k1",
        name: "tool",
        parentId: "t1",
        startNs: 8000n,
        endNs: 9000n,
      }),
    ];

    const report = attributionFromSpans(spans);
    const inf = categoryShare(report.session.categories, "inference");
    const tools = categoryShare(report.session.categories, "tools");
    const sub = categoryShare(report.session.categories, "subagent");
    const other = categoryShare(report.session.categories, "other");

    expect(inf.ns).toBe(2000);
    expect(sub.ns).toBe(6000);
    expect(tools.ns).toBe(1000); // only the top-level tool, not sa_k1
    expect(other.ns).toBe(1000); // 10000 - 2000 - 6000 - 1000
    expect(inf.count).toBe(1); // nested inference under subagent not counted
    expect(sub.count).toBe(1);
    // toolCount still sees nested tools for visibility
    expect(report.session.toolCount).toBe(2);
    expect(report.session.subagentCount).toBe(1);

    const shareSum = report.session.categories.reduce((a, c) => a + c.share, 0);
    expect(shareSum).toBeCloseTo(1, 10);

    // Nested diagnostics still roll up (parent + subagent ttft/stream)
    expect(report.session.inference.ttftNs).toBe(400 + 500);
    expect(report.session.inference.streamNs).toBe(1600 + 2000);

    const turnShareSum = report.turns[0]!.categories.reduce((a, c) => a + c.share, 0);
    expect(turnShareSum).toBeCloseTo(1, 10);
  });
});

describe("attributionFromSpans — open (stall) turns", () => {
  test("open turn wall is max completed-descendant end minus turn start", () => {
    // Mid-stall dump: turn still open; inference + tool completed; stream still open.
    const spans: PerfSpan[] = [
      span({ id: "t1", name: "turn", startNs: 100n }), // open
      span({
        id: "i1",
        name: "inference",
        parentId: "t1",
        startNs: 100n,
        endNs: 2100n, // 2000ns
      }),
      span({
        id: "ttft1",
        name: "inference.ttft",
        parentId: "i1",
        startNs: 100n,
        endNs: 500n,
      }),
      span({
        id: "stream1",
        name: "inference.stream",
        parentId: "i1",
        startNs: 500n, // still open — contributes 0 to streamNs
      }),
      span({
        id: "k1",
        name: "tool",
        parentId: "t1",
        startNs: 2100n,
        endNs: 3100n, // 1000ns; max end → wall = 3100 - 100 = 3000
      }),
    ];

    const report = attributionFromSpans(spans);
    expect(report.session.completedTurnCount).toBe(0);
    expect(report.session.turnCount).toBe(1);
    // wall = maxEnd(3100) - start(100) = 3000
    expect(report.session.wallNs).toBe(3000);
    expect(report.turns[0]!.open).toBe(true);
    expect(report.turns[0]!.turnNs).toBe(3000);
    expect(report.session.open).toBe(true);
    // Still-running: turn + open stream (completed inference/tool are not listed)
    expect(report.session.openPhases).toEqual(["inference.stream", "turn"]);
    expect(report.turns[0]!.openPhases).toEqual(["inference.stream", "turn"]);

    expect(categoryShare(report.session.categories, "inference").ns).toBe(2000);
    expect(categoryShare(report.session.categories, "tools").ns).toBe(1000);
    // other = 3000 - 2000 - 1000 = 0
    expect(categoryShare(report.session.categories, "other").ns).toBe(0);

    const shareSum = report.session.categories.reduce((a, c) => a + c.share, 0);
    expect(shareSum).toBeCloseTo(1, 10);

    const turnShareSum = report.turns[0]!.categories.reduce((a, c) => a + c.share, 0);
    expect(turnShareSum).toBeCloseTo(1, 10);
  });

  test("mixed completed + open turns: session shares sum to ~1", () => {
    const spans: PerfSpan[] = [
      // completed turn: wall 5000
      span({ id: "t0", name: "turn", startNs: 0n, endNs: 5000n }),
      span({
        id: "i0",
        name: "inference",
        parentId: "t0",
        startNs: 0n,
        endNs: 3000n,
      }),
      span({
        id: "k0",
        name: "tool",
        parentId: "t0",
        startNs: 3000n,
        endNs: 4000n,
      }),
      // open stall turn: estimated wall 2000 (max end 7000 - start 5000)
      span({ id: "t1", name: "turn", startNs: 5000n }),
      span({
        id: "i1",
        name: "inference",
        parentId: "t1",
        startNs: 5000n,
        endNs: 6500n, // 1500
      }),
      span({
        id: "k1",
        name: "tool",
        parentId: "t1",
        startNs: 6500n,
        endNs: 7000n, // 500; max end → wall 2000
      }),
      span({
        id: "stream1",
        name: "inference.stream",
        parentId: "i1",
        startNs: 5500n, // open child — 0 duration
      }),
    ];

    const report = attributionFromSpans(spans);
    expect(report.session.completedTurnCount).toBe(1);
    expect(report.session.turnCount).toBe(2);
    // wall = 5000 + 2000 = 7000
    expect(report.session.wallNs).toBe(7000);
    // inference 3000+1500=4500; tools 1000+500=1500; other = 7000-6000=1000
    expect(categoryShare(report.session.categories, "inference").ns).toBe(4500);
    expect(categoryShare(report.session.categories, "tools").ns).toBe(1500);
    expect(categoryShare(report.session.categories, "other").ns).toBe(1000);

    const shareSum = report.session.categories.reduce((a, c) => a + c.share, 0);
    expect(shareSum).toBeCloseTo(1, 10);

    const openTurn = report.turns.find((t) => t.turnId === "t1")!;
    expect(openTurn.open).toBe(true);
    expect(openTurn.turnNs).toBe(2000);
    const openShareSum = openTurn.categories.reduce((a, c) => a + c.share, 0);
    expect(openShareSum).toBeCloseTo(1, 10);
  });

  test("open turn with no completed descendants has zero wall and zero shares", () => {
    const spans: PerfSpan[] = [
      span({ id: "t1", name: "turn", startNs: 0n }),
      span({
        id: "i1",
        name: "inference",
        parentId: "t1",
        startNs: 0n, // still open
      }),
    ];
    const report = attributionFromSpans(spans);
    expect(report.session.wallNs).toBe(0);
    expect(report.turns[0]!.open).toBe(true);
    expect(report.turns[0]!.turnNs).toBe(0);
    expect(report.session.open).toBe(true);
    expect(report.session.openPhases).toEqual(["inference", "turn"]);
    expect(report.turns[0]!.openPhases).toEqual(["inference", "turn"]);
    for (const c of report.session.categories) {
      expect(c.share).toBe(0);
      expect(c.ns).toBe(0);
    }
  });
});

describe("dump round-trip", () => {
  test("attributionFromDump matches live spans", () => {
    const spans = multiToolTurnFixture();
    const dump = buildDump(spans, "fixture-multi", "2026-04-08T00:00:00.000Z");
    const fromDump = attributionFromDump(dump);
    const live = attributionFromSpans(spans);

    expect(fromDump.session.wallNs).toBe(live.session.wallNs);
    expect(fromDump.session.categories).toEqual(live.session.categories);
    expect(fromDump.session.inference).toEqual(live.session.inference);
    expect(fromDump.turns).toEqual(live.turns);
  });

  test("spansFromDumpJson accepts bare span arrays", () => {
    const serialized = multiToolTurnFixture().map(serializeSpan);
    const spans = spansFromDumpJson(serialized);
    expect(spans).toHaveLength(7);
    expect(spans[0]!.startNs).toBe(0n);
    expect(deserializeDumpSpan(serialized[0]!).id).toBe("t1");
  });

  test("attributionFromDump rejects unsupported DUMP_VERSION", () => {
    const dump = buildDump(multiToolTurnFixture(), "fixture-multi", "2026-04-08T00:00:00.000Z");
    expect(() => attributionFromDump({ ...dump, version: DUMP_VERSION + 1 })).toThrow(
      /unsupported dump version/,
    );
  });
});

describe("formatAttributionReport", () => {
  test("prints category labels and percentages for the golden fixture", () => {
    const text = formatAttributionReport(attributionFromSpans(multiToolTurnFixture()));
    expect(text).toContain("PerfTrace attribution report");
    expect(text).toContain("inference");
    expect(text).toContain("tools");
    expect(text).toContain("permission.wait");
    expect(text).toContain("subagent");
    expect(text).toContain("other");
    expect(text).toContain("40.0%"); // inference 2000/5000
    expect(text).toContain("24.0%"); // tools 1200/5000
    expect(text).toContain("turn t1");
    expect(text).toContain("Inference split (of ttft+stream)");
    expect(text).not.toContain("Open (incomplete)");
  });

  test("surfaces open phases for mid-stall dumps", () => {
    const spans: PerfSpan[] = [
      span({ id: "t1", name: "turn", startNs: 0n }),
      span({
        id: "i1",
        name: "inference",
        parentId: "t1",
        startNs: 0n,
        endNs: 1000n,
      }),
      span({
        id: "stream1",
        name: "inference.stream",
        parentId: "i1",
        startNs: 200n,
      }),
      span({
        id: "k1",
        name: "tool",
        parentId: "t1",
        startNs: 1000n,
        endNs: 1500n,
      }),
    ];
    const text = formatAttributionReport(attributionFromSpans(spans));
    expect(text).toContain("Open (incomplete)");
    expect(text).toContain("inference.stream");
    expect(text).toContain("open phases:");
    expect(text).toContain("shares incomplete");
    expect(text).toContain("not a full stall diagnosis");
  });
});
