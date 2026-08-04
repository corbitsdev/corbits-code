import { describe, expect, test } from "bun:test";
import {
  attributionFromDump,
  attributionFromSpans,
  categoryShare,
  deserializeDumpSpan,
  formatAttributionReport,
  spansFromDumpJson,
} from "./attribution-report.js";
import { buildDump, serializeSpan } from "./dump.js";
import {
  MULTI_TOOL_TURN_GOLDEN,
  multiToolTurnFixture,
} from "./fixtures/multi-tool-turn.js";
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
});

describe("formatAttributionReport", () => {
  test("prints category labels and percentages for the golden fixture", () => {
    const text = formatAttributionReport(
      attributionFromSpans(multiToolTurnFixture()),
    );
    expect(text).toContain("PerfTrace attribution report");
    expect(text).toContain("inference");
    expect(text).toContain("tools");
    expect(text).toContain("permission.wait");
    expect(text).toContain("subagent");
    expect(text).toContain("other");
    expect(text).toContain("40.0%"); // inference 2000/5000
    expect(text).toContain("24.0%"); // tools 1200/5000
    expect(text).toContain("turn t1");
  });
});
