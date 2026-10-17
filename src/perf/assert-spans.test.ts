/**
 * Latency eval harness: golden multi-tool fixture equality and one
 * end-to-end observer smoke. Rollup arithmetic lives in rollup.test.ts.
 */

import { defined } from "../../testkit/defined.js";
import { describe, expect, test } from "bun:test";
import {
  MULTI_TOOL_TURN_GOLDEN,
  multiToolTurnFixture,
} from "./fixtures/multi-tool-turn.js";
import {
  completed,
  event,
  inferenceDone,
  useCleanSpanStore,
} from "./fixtures/spans.js";
import { ALLOWED_TAG_KEYS, snapshot, type PerfSpan } from "./index.js";
import { createPerfReactorObserver } from "./reactor-spans.js";
import { rollupByPhase, rollupByTurn } from "./rollup.js";

// The span store is process-wide, so a perf test cannot assume the tests that
// ran before it in this process left it empty. Reset on both edges.
useCleanSpanStore();

const ALLOWED_TAG_KEY_SET: ReadonlySet<string> = new Set(ALLOWED_TAG_KEYS);

function nestedUnder(
  spans: readonly PerfSpan[],
  childName: string,
  parentName: string,
): boolean {
  const byId = new Map(spans.map((span) => [span.id, span]));
  return spans.some((child) => {
    if (child.name !== childName || child.parentId === undefined) return false;
    const parent = byId.get(child.parentId);
    return parent !== undefined && parent.name === parentName;
  });
}

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
    const turn = defined(rollupByTurn(multiToolTurnFixture())[0]);
    expect(turn.ttftNs).toBeLessThan(turn.streamNs);
  });
});

describe("observer pipeline → snapshot → rollup → assertions", () => {
  test("multi-tool reactor events produce assertable turn rollup", () => {
    const obs = createPerfReactorObserver();

    obs.observe(event("inference.start", { model: "test-model" }));
    obs.observe(
      event("inference.text.delta", { token: "x", partial: { text: "x" } }),
    );
    obs.observe(
      inferenceDone([
        { type: "tool_call", id: "call-a", name: "read_file", arguments: {} },
        { type: "tool_call", id: "call-b", name: "edit_file", arguments: {} },
      ]),
    );
    obs.observe(
      event("tool.start", {
        call: { id: "call-a", name: "read_file", arguments: {} },
      }),
    );
    obs.observe(
      event("tool.done", { result: { callId: "call-a", content: "ok" } }),
    );
    obs.observe(
      event("tool.start", {
        call: { id: "call-b", name: "edit_file", arguments: {} },
      }),
    );
    obs.observe(
      event("tool.done", { result: { callId: "call-b", content: "ok" } }),
    );

    const spans = completed(snapshot());

    for (const phase of [
      "turn",
      "inference",
      "inference.ttft",
      "inference.stream",
      "tool",
    ]) {
      expect(spans.some((span) => span.name === phase)).toBe(true);
    }

    expect(nestedUnder(spans, "inference", "turn")).toBe(true);
    expect(nestedUnder(spans, "inference.ttft", "inference")).toBe(true);
    expect(nestedUnder(spans, "inference.stream", "inference")).toBe(true);
    expect(nestedUnder(spans, "tool", "turn")).toBe(true);

    const turns = rollupByTurn(spans);
    expect(turns).toHaveLength(1);
    const turn = defined(turns[0]);
    expect(turn.inferenceNs).toBeGreaterThan(0);
    expect(turn.toolCount).toBe(2);
    expect(turn.toolNs).toBeGreaterThan(0);

    // Live clock: duration magnitudes are non-deterministic under sync hrtime
    // (ttftNs can exceed streamNs). Assert wall ordering instead of a no-op
    // `>= 0` check: TTFT must end at or before stream starts when both exist.
    const ttft = spans.find((s) => s.name === "inference.ttft");
    const stream = spans.find((s) => s.name === "inference.stream");
    expect(ttft?.endNs).toBeDefined();
    expect(stream?.startNs).toBeDefined();
    if (stream !== undefined) {
      const ttftEndNs = defined(ttft, "ttft").endNs;
      if (ttftEndNs !== undefined) {
        expect(ttftEndNs <= stream.startNs).toBe(true);
      }
    }

    const phases = rollupByPhase(spans);
    expect(
      phases.find((phase) => phase.name === "tool")?.count,
    ).toBeGreaterThanOrEqual(2);
    expect(
      phases.find((phase) => phase.name === "inference")?.count,
    ).toBeGreaterThanOrEqual(1);
  });
});
