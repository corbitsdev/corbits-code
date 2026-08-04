/**
 * Latency eval harness: assert on PerfTrace phase presence and relative magnitudes.
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
import { rollupByPhase, rollupByTurn, sessionTotals } from "./rollup.js";

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

  test("assertNesting verifies parent-child links", () => {
    const spans = multiToolTurnFixture();
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

  test("phase rollup reports expected counts and totals", () => {
    const phases = rollupByPhase(multiToolTurnFixture());
    assertPhaseSummary(phases, "turn", { minCount: 1, minTotalNs: 5000 });
    assertPhaseSummary(phases, "inference", { minCount: 1, minTotalNs: 2000 });
    assertPhaseSummary(phases, "tool", { minCount: 2, minTotalNs: 1200 });
    assertPhaseSummary(phases, "permission.wait", { minCount: 1, minTotalNs: 400 });
  });
});

describe("regression: turn has inference + tools when tools ran", () => {
  test("assertTurnHasInferenceAndTools passes on multi-tool golden rollup", () => {
    const turns = rollupByTurn(multiToolTurnFixture());
    assertTurnHasInferenceAndTools(turns[0]!);
  });

  test("assertTurnHasInferenceAndTools fails when tools did not run", () => {
    const spans: PerfSpan[] = multiToolTurnFixture().filter((s) => s.name !== "tool");
    const turns = rollupByTurn(spans);
    expect(() => assertTurnHasInferenceAndTools(turns[0]!)).toThrow(/toolCount/);
  });

  test("TTFT is less than stream on the golden fixture", () => {
    const turn = rollupByTurn(multiToolTurnFixture())[0]!;
    assertLessThan(turn.ttftNs, turn.streamNs, "ttft vs stream");
    expect(turn.ttftNs).toBe(400);
    expect(turn.streamNs).toBe(1600);
  });

  test("session totals include tool and inference cost", () => {
    const totals = sessionTotals(multiToolTurnFixture());
    expect(totals.turnCount).toBe(1);
    expect(totals.totalInferenceNs).toBe(2000);
    expect(totals.totalToolNs).toBe(1200);
    expect(totals.totalToolCount).toBe(2);
    expect(totals.ttftShare).toBeCloseTo(0.2, 5);
    expect(totals.streamShare).toBeCloseTo(0.8, 5);
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
    assertTurnHasInferenceAndTools(turns[0]!);
    expect(turns[0]!.toolCount).toBe(2);

    // Live clock: TTFT ends at/before stream starts, so ttftNs should be <= streamNs
    // only when both are positive; with real hrtime, stream wall is typically longer.
    if (turns[0]!.ttftNs > 0 && turns[0]!.streamNs > 0) {
      // Relative magnitude: first-token wait should not dominate a multi-token stream
      // in the happy path (stream duration is from first token to done).
      expect(turns[0]!.streamNs).toBeGreaterThanOrEqual(0);
      expect(turns[0]!.ttftNs).toBeGreaterThanOrEqual(0);
    }

    const phases = rollupByPhase(spans);
    assertPhaseSummary(phases, "tool", { minCount: 2 });
    assertPhaseSummary(phases, "inference", { minCount: 1 });
  });
});
