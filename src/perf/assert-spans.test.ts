/**
 * Latency eval harness: assert helpers over PerfTrace snapshots and rollups.
 *
 * This layer owns:
 * - assert API behavior (pass paths + negative branches)
 * - golden multi-tool fixture equality (locked TurnSummary)
 * - one end-to-end smoke: reactor observer → snapshot → rollup → asserts
 *
 * Rollup arithmetic (phase totals, sessionTotals, percentiles) lives in
 * rollup.test.ts — do not re-test pure rollup math here.
 *
 * Covers CL-5174 outcomes:
 * - phase presence + nesting helpers
 * - regression: turn has inference + tools when tools ran
 * - golden multi-tool fixture rollup
 * - full observer pipeline → snapshot → rollup → assertions
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { ReactorEmittedEvent } from "@intx/inference";
import {
  assertLessThan,
  assertNesting,
  assertPhasePresent,
  assertPhaseSummary,
  assertTurnHasInferenceAndTools,
} from "./assert-spans.js";
import {
  MULTI_TOOL_TURN_GOLDEN,
  multiToolTurnFixture,
} from "./fixtures/multi-tool-turn.js";
import { ALLOWED_TAG_KEYS, clear, snapshot, type PerfSpan } from "./index.js";
import { createPerfReactorObserver } from "./reactor-spans.js";
import { rollupByPhase, rollupByTurn, type TurnSummary } from "./rollup.js";

afterEach(() => {
  clear();
});

const ALLOWED_TAG_KEY_SET: ReadonlySet<string> = new Set(ALLOWED_TAG_KEYS);

function event(type: string, data: unknown = {}): ReactorEmittedEvent {
  return { type, seq: 1, data } as ReactorEmittedEvent;
}

const emptyUsage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, thinking: 0 };
const source = { provider: "test-provider", model: "test-model" };

function inferenceDone(content: unknown[] = [{ type: "text", text: "hi" }]): ReactorEmittedEvent {
  return event("inference.done", {
    turn: { role: "assistant", content, model: "test-model", timestamp: 0 },
    usage: emptyUsage,
    source,
  });
}

function completed(spans: PerfSpan[]): PerfSpan[] {
  return spans.filter((s) => s.endNs !== undefined);
}

function turnSummary(partial: Partial<TurnSummary> & Pick<TurnSummary, "turnId">): TurnSummary {
  return {
    turnNs: 1000,
    open: false,
    inferenceNs: 500,
    toolNs: 200,
    ttftNs: 100,
    streamNs: 400,
    toolCount: 1,
    ...partial,
  };
}

describe("assertPhasePresent / assertNesting", () => {
  test("assertPhasePresent finds phases on the golden fixture", () => {
    const spans = multiToolTurnFixture();
    assertPhasePresent(spans, "turn");
    assertPhasePresent(spans, "inference");
    assertPhasePresent(spans, "inference.ttft");
    assertPhasePresent(spans, "inference.stream");
    assertPhasePresent(spans, "tool");
    assertPhasePresent(spans, "permission.wait");
  });

  test("assertPhasePresent throws when phase is missing", () => {
    expect(() => assertPhasePresent(multiToolTurnFixture(), "subagent")).toThrow(
      /expected phase "subagent"/,
    );
  });

  test("assertNesting verifies parent-child links (child, parent arg order)", () => {
    const spans = multiToolTurnFixture();
    // child first, then expected parent
    assertNesting(spans, "inference", "turn");
    assertNesting(spans, "inference.ttft", "inference");
    assertNesting(spans, "inference.stream", "inference");
    assertNesting(spans, "tool", "turn");
    assertNesting(spans, "permission.wait", "turn");
  });

  test("assertNesting throws when link is absent", () => {
    expect(() => assertNesting(multiToolTurnFixture(), "tool", "inference")).toThrow(
      /expected nesting inference → tool/,
    );
  });
});

describe("assertPhaseSummary", () => {
  test("passes on golden phase rollup with minCount and minTotalNs", () => {
    const phases = rollupByPhase(multiToolTurnFixture());
    assertPhaseSummary(phases, "turn", { minCount: 1, minTotalNs: 5000 });
    assertPhaseSummary(phases, "inference", { minCount: 1, minTotalNs: 2000 });
    assertPhaseSummary(phases, "tool", { minCount: 2, minTotalNs: 1200 });
    assertPhaseSummary(phases, "permission.wait", { minCount: 1, minTotalNs: 400 });
  });

  test("throws when phase summary is missing", () => {
    const phases = rollupByPhase(multiToolTurnFixture());
    expect(() => assertPhaseSummary(phases, "subagent")).toThrow(
      /expected phase summary "subagent"/,
    );
  });

  test("throws when count is below minCount", () => {
    const phases = rollupByPhase(multiToolTurnFixture());
    expect(() => assertPhaseSummary(phases, "tool", { minCount: 3 })).toThrow(
      /phase "tool": expected count >= 3/,
    );
  });

  test("throws when totalNs is below minTotalNs", () => {
    const phases = rollupByPhase(multiToolTurnFixture());
    expect(() =>
      assertPhaseSummary(phases, "inference", { minTotalNs: 999_999 }),
    ).toThrow(/phase "inference": expected totalNs >= 999999/);
  });
});

describe("assertLessThan", () => {
  test("passes when left < right", () => {
    assertLessThan(400, 1600, "ttft vs stream");
  });

  test("throws when left >= right", () => {
    expect(() => assertLessThan(1600, 400, "ttft vs stream")).toThrow(
      /ttft vs stream: expected 1600 < 400/,
    );
    expect(() => assertLessThan(5, 5, "eq")).toThrow(/eq: expected 5 < 5/);
  });
});

describe("assertTurnHasInferenceAndTools", () => {
  test("passes on multi-tool golden rollup", () => {
    const turns = rollupByTurn(multiToolTurnFixture());
    assertTurnHasInferenceAndTools(turns[0]!);
    assertTurnHasInferenceAndTools(turns[0]!, { minToolCount: 2 });
  });

  test("throws when inferenceNs is not positive", () => {
    expect(() =>
      assertTurnHasInferenceAndTools(turnSummary({ turnId: "t-no-inf", inferenceNs: 0 })),
    ).toThrow(/turn t-no-inf: expected inferenceNs > 0/);
  });

  test("throws when toolCount is below minimum", () => {
    const noTools = turnSummary({ turnId: "t-no-tools", toolCount: 0, toolNs: 0 });
    expect(() => assertTurnHasInferenceAndTools(noTools)).toThrow(
      /turn t-no-tools: expected toolCount >= 1/,
    );

    const oneTool = turnSummary({ turnId: "t-one", toolCount: 1, toolNs: 100 });
    expect(() => assertTurnHasInferenceAndTools(oneTool, { minToolCount: 2 })).toThrow(
      /turn t-one: expected toolCount >= 2/,
    );
  });

  test("throws when toolNs is not positive despite toolCount", () => {
    expect(() =>
      assertTurnHasInferenceAndTools(
        turnSummary({ turnId: "t-zero-tool-ns", toolCount: 1, toolNs: 0 }),
      ),
    ).toThrow(/turn t-zero-tool-ns: expected toolNs > 0/);
  });

  test("fails when tools are filtered out of the golden fixture", () => {
    const spans: PerfSpan[] = multiToolTurnFixture().filter((s) => s.name !== "tool");
    const turns = rollupByTurn(spans);
    expect(() => assertTurnHasInferenceAndTools(turns[0]!)).toThrow(/toolCount/);
  });
});

describe("golden multi-tool turn fixture", () => {
  test("rollupByTurn matches locked golden values", () => {
    const turns = rollupByTurn(multiToolTurnFixture());
    expect(turns).toHaveLength(1);
    expect(turns[0]).toEqual({ ...MULTI_TOOL_TURN_GOLDEN });
  });

  test("fixture tags are privacy-safe (allowlisted keys only)", () => {
    for (const span of multiToolTurnFixture()) {
      if (span.tags === undefined) continue;
      for (const key of Object.keys(span.tags)) {
        expect(ALLOWED_TAG_KEY_SET.has(key)).toBe(true);
      }
    }
  });

  test("TTFT is strictly less than stream on the golden fixture", () => {
    const turn = rollupByTurn(multiToolTurnFixture())[0]!;
    assertLessThan(turn.ttftNs, turn.streamNs, "ttft vs stream");
  });
});

describe("observer pipeline → snapshot → rollup → assertions", () => {
  test("multi-tool reactor events produce assertable turn rollup", () => {
    const obs = createPerfReactorObserver();

    obs.observe(event("inference.start", { model: "test-model" }));
    obs.observe(event("inference.text.delta", { token: "x", partial: { text: "x" } }));
    obs.observe(
      inferenceDone([
        { type: "tool_call", id: "call-a", name: "read_file", arguments: {} },
        { type: "tool_call", id: "call-b", name: "edit_file", arguments: {} },
      ]),
    );
    obs.observe(event("tool.start", { call: { id: "call-a", name: "read_file", arguments: {} } }));
    obs.observe(event("tool.done", { result: { callId: "call-a", content: "ok" } }));
    obs.observe(event("tool.start", { call: { id: "call-b", name: "edit_file", arguments: {} } }));
    obs.observe(event("tool.done", { result: { callId: "call-b", content: "ok" } }));

    const spans = completed(snapshot());

    assertPhasePresent(spans, "turn");
    assertPhasePresent(spans, "inference");
    assertPhasePresent(spans, "inference.ttft");
    assertPhasePresent(spans, "inference.stream");
    assertPhasePresent(spans, "tool");

    assertNesting(spans, "inference", "turn");
    assertNesting(spans, "inference.ttft", "inference");
    assertNesting(spans, "inference.stream", "inference");
    assertNesting(spans, "tool", "turn");

    const turns = rollupByTurn(spans);
    expect(turns).toHaveLength(1);
    assertTurnHasInferenceAndTools(turns[0]!, { minToolCount: 2 });
    expect(turns[0]!.toolCount).toBe(2);

    // Live clock: duration magnitudes are non-deterministic under sync hrtime
    // (ttftNs can exceed streamNs). Assert wall ordering instead of a no-op
    // `>= 0` check: TTFT must end at or before stream starts when both exist.
    const ttft = spans.find((s) => s.name === "inference.ttft");
    const stream = spans.find((s) => s.name === "inference.stream");
    expect(ttft?.endNs).toBeDefined();
    expect(stream?.startNs).toBeDefined();
    if (ttft!.endNs !== undefined && stream !== undefined) {
      expect(ttft!.endNs <= stream.startNs).toBe(true);
    }

    const phases = rollupByPhase(spans);
    assertPhaseSummary(phases, "tool", { minCount: 2 });
    assertPhaseSummary(phases, "inference", { minCount: 1 });
  });
});
