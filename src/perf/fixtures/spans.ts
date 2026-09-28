/**
 * Shared span builders and reactor-event fixtures for perf tests. `span`
 * builds a PerfSpan with fixed nanosecond times (no live clock); the
 * `event`/`inferenceDone` pair feeds `createPerfReactorObserver`.
 */

import { afterEach, beforeEach } from "bun:test";
import type { ReactorEmittedEvent } from "@intx/inference";
import { clear, type PerfSpan } from "../index.js";

/**
 * The span store is process-wide, so a perf test cannot assume the tests that
 * ran before it in this process left it empty. Reset on both edges.
 */
export function useCleanSpanStore(): void {
  beforeEach(() => {
    clear();
  });

  afterEach(() => {
    clear();
  });
}

/** Build a span with fixed times (no live clock). */
export function span(partial: {
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

export function event(type: string, data: unknown = {}): ReactorEmittedEvent {
  return { type, seq: 1, data } as ReactorEmittedEvent;
}

const emptyUsage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  thinking: 0,
};
const source = { provider: "test-provider", model: "test-model" };

export function inferenceDone(
  content: unknown[] = [{ type: "text", text: "hi" }],
): ReactorEmittedEvent {
  return event("inference.done", {
    turn: { role: "assistant", content, model: "test-model", timestamp: 0 },
    usage: emptyUsage,
    source,
  });
}

export function completed(spans: PerfSpan[]): PerfSpan[] {
  return spans.filter((s) => s.endNs !== undefined);
}
