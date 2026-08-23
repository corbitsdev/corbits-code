/**
 * Pure rollup helpers over PerfSpan snapshots.
 *
 * No I/O, no module state. Inputs are bigint nanoseconds; outputs use plain
 * numbers so they serialize with JSON without custom revivers. Types are
 * exported for reuse by a future OTEL sink.
 */

import type { PerfSpan, SpanName } from "./index.js";

/** Per-phase aggregate: total wall under that name, count, and percentiles. */
export interface PhaseSummary {
  name: SpanName;
  count: number;
  /** Spans still open (no endNs) — excluded from duration stats. */
  openCount: number;
  totalNs: number;
  p50Ns: number;
  p95Ns: number;
}

/** One turn and the nested inference / tool / TTFT / stream cost under it. */
export interface TurnSummary {
  turnId: string;
  /** Wall time of the turn span itself; 0 when still open. */
  turnNs: number;
  open: boolean;
  inferenceNs: number;
  toolNs: number;
  ttftNs: number;
  streamNs: number;
  toolCount: number;
}

/** Session-wide sums and TTFT vs stream split. */
export interface SessionTotals {
  turnCount: number;
  completedTurnCount: number;
  totalTurnNs: number;
  totalInferenceNs: number;
  totalToolNs: number;
  totalTtftNs: number;
  totalStreamNs: number;
  totalToolCount: number;
  /**
   * Share of (ttft + stream) spent in TTFT. 0 when both sides are zero.
   * Values are in [0, 1].
   */
  ttftShare: number;
  /** Share of (ttft + stream) spent streaming after first token. */
  streamShare: number;
}

/** Completed duration in ns, or undefined when the span is still open. */
export function spanDurationNs(span: PerfSpan): number | undefined {
  if (span.endNs === undefined) return undefined;
  const d = span.endNs - span.startNs;
  if (d <= 0n) return 0;
  // Process-lifetime hrtime deltas stay well inside Number.MAX_SAFE_INTEGER.
  return Number(d);
}

function percentileNearestRank(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  // Nearest-rank: ceil(p * n), 1-indexed → 0-indexed clamp.
  const rank = Math.ceil(p * sortedAsc.length) - 1;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, rank));
  return sortedAsc[idx]!;
}

/**
 * Aggregate every span by phase name. Open spans contribute to count/openCount
 * but not to totalNs or percentiles.
 */
export function rollupByPhase(spans: readonly PerfSpan[]): PhaseSummary[] {
  const byName = new Map<SpanName, { durations: number[]; openCount: number; count: number }>();

  for (const span of spans) {
    let bucket = byName.get(span.name);
    if (bucket === undefined) {
      bucket = { durations: [], openCount: 0, count: 0 };
      byName.set(span.name, bucket);
    }
    bucket.count += 1;
    const dur = spanDurationNs(span);
    if (dur === undefined) {
      bucket.openCount += 1;
    } else {
      bucket.durations.push(dur);
    }
  }

  const out: PhaseSummary[] = [];
  for (const [name, bucket] of byName) {
    const sorted = bucket.durations.slice().sort((a, b) => a - b);
    let totalNs = 0;
    for (const d of sorted) totalNs += d;
    out.push({
      name,
      count: bucket.count,
      openCount: bucket.openCount,
      totalNs,
      p50Ns: percentileNearestRank(sorted, 0.5),
      p95Ns: percentileNearestRank(sorted, 0.95),
    });
  }

  // Stable order: SPAN_NAMES order first, then any remaining by name.
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Build parent → children index. Orphans (parent missing after ring eviction)
 * still appear as roots for by-phase; by-turn only lists actual turn spans.
 * Shared with attribution-report (exclusive shares walk the same tree).
 */
export function childrenOf(spans: readonly PerfSpan[]): Map<string, PerfSpan[]> {
  const byParent = new Map<string, PerfSpan[]>();
  for (const span of spans) {
    if (span.parentId === undefined) continue;
    const list = byParent.get(span.parentId);
    if (list === undefined) {
      byParent.set(span.parentId, [span]);
    } else {
      list.push(span);
    }
  }
  return byParent;
}

/** Depth-first walk of the subtree rooted at `rootId` (excluding the root). */
export function walkDescendants(
  rootId: string,
  byParent: Map<string, PerfSpan[]>,
  visit: (span: PerfSpan) => void,
): void {
  const stack = byParent.get(rootId);
  if (stack === undefined) return;
  // Copy so callers can mutate freely; walk iteratively to avoid deep recursion.
  const work: PerfSpan[] = stack.slice();
  while (work.length > 0) {
    const span = work.pop()!;
    visit(span);
    const kids = byParent.get(span.id);
    if (kids !== undefined) {
      for (const k of kids) work.push(k);
    }
  }
}

/**
 * Per-turn rollup. Children are attributed via parentId links
 * (turn → inference → {ttft, stream}; turn → tool).
 * Turns are ordered by startNs ascending.
 */
export function rollupByTurn(spans: readonly PerfSpan[]): TurnSummary[] {
  const byParent = childrenOf(spans);
  const turns = spans
    .filter((s) => s.name === "turn")
    .slice()
    .sort((a, b) => (a.startNs < b.startNs ? -1 : a.startNs > b.startNs ? 1 : 0));

  return turns.map((turn) => {
    let inferenceNs = 0;
    let toolNs = 0;
    let ttftNs = 0;
    let streamNs = 0;
    let toolCount = 0;

    walkDescendants(turn.id, byParent, (child) => {
      const dur = spanDurationNs(child) ?? 0;
      switch (child.name) {
        case "inference":
          inferenceNs += dur;
          break;
        case "tool":
          toolNs += dur;
          toolCount += 1;
          break;
        case "inference.ttft":
          ttftNs += dur;
          break;
        case "inference.stream":
          streamNs += dur;
          break;
        default:
          break;
      }
    });

    const turnDur = spanDurationNs(turn);
    return {
      turnId: turn.id,
      turnNs: turnDur ?? 0,
      open: turnDur === undefined,
      inferenceNs,
      toolNs,
      ttftNs,
      streamNs,
      toolCount,
    };
  });
}

/**
 * Session totals summed across turns, plus TTFT vs stream ratio over the
 * whole snapshot (not only under turns — orphans still count toward phase sums).
 */
export function sessionTotals(spans: readonly PerfSpan[]): SessionTotals {
  const turns = rollupByTurn(spans);

  let totalTurnNs = 0;
  let totalInferenceNs = 0;
  let totalToolNs = 0;
  let totalTtftNs = 0;
  let totalStreamNs = 0;
  let totalToolCount = 0;
  let completedTurnCount = 0;

  for (const t of turns) {
    totalTurnNs += t.turnNs;
    totalInferenceNs += t.inferenceNs;
    totalToolNs += t.toolNs;
    totalTtftNs += t.ttftNs;
    totalStreamNs += t.streamNs;
    totalToolCount += t.toolCount;
    if (!t.open) completedTurnCount += 1;
  }

  // Prefer turn-scoped sums; if no turns, fall back to flat phase totals so a
  // partial snapshot (evicted roots) still reports something useful.
  if (turns.length === 0) {
    for (const span of spans) {
      const dur = spanDurationNs(span) ?? 0;
      switch (span.name) {
        case "inference":
          totalInferenceNs += dur;
          break;
        case "tool":
          totalToolNs += dur;
          totalToolCount += 1;
          break;
        case "inference.ttft":
          totalTtftNs += dur;
          break;
        case "inference.stream":
          totalStreamNs += dur;
          break;
        default:
          break;
      }
    }
  }

  const split = totalTtftNs + totalStreamNs;
  const ttftShare = split === 0 ? 0 : totalTtftNs / split;
  const streamShare = split === 0 ? 0 : totalStreamNs / split;

  return {
    turnCount: turns.length,
    completedTurnCount,
    totalTurnNs,
    totalInferenceNs,
    totalToolNs,
    totalTtftNs,
    totalStreamNs,
    totalToolCount,
    ttftShare,
    streamShare,
  };
}
