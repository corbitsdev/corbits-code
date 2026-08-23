/**
 * Eval / test harness assertions over PerfTrace snapshots and rollups.
 *
 * Pure helpers: throw Error with a clear message on failure (no bun:test import).
 * Use from unit tests, capability evals, or ad-hoc scripts after snapshot()/rollup.
 */

import type { PerfSpan, SpanName } from "./index.js";
import type { PhaseSummary, TurnSummary } from "./rollup.js";
import { spanDurationNs } from "./rollup.js";

/** Verify at least one span with the given phase name exists. */
export function assertPhasePresent(spans: readonly PerfSpan[], phaseName: SpanName | string): void {
  const found = spans.some((s) => s.name === phaseName);
  if (!found) {
    const names = [...new Set(spans.map((s) => s.name))].sort().join(", ");
    throw new Error(
      `expected phase "${phaseName}" in snapshot; present phases: [${names || "none"}]`,
    );
  }
}

/**
 * Verify at least one span named `childName` is nested under a span named
 * `parentName` (via parentId → id).
 *
 * Arg order: (spans, child, parent) — the nested phase first, then its expected
 * parent. Example: `assertNesting(spans, "inference", "turn")` means an
 * inference span has parentId pointing at a turn span.
 */
export function assertNesting(
  spans: readonly PerfSpan[],
  childName: SpanName | string,
  parentName: SpanName | string,
): void {
  const byId = new Map(spans.map((s) => [s.id, s]));
  const ok = spans.some((child) => {
    if (child.name !== childName || child.parentId === undefined) return false;
    const parent = byId.get(child.parentId);
    return parent !== undefined && parent.name === parentName;
  });
  if (!ok) {
    throw new Error(
      `expected nesting ${parentName} → ${childName}; no matching parentId link found`,
    );
  }
}

export interface TurnInferenceToolsOpts {
  /** Minimum tool invocations required (default 1). */
  minToolCount?: number;
}

/**
 * Regression: a turn that ran tools must report positive inference and tool cost.
 * Accepts a single TurnSummary (from rollupByTurn).
 */
export function assertTurnHasInferenceAndTools(
  turn: TurnSummary,
  opts?: TurnInferenceToolsOpts,
): void {
  const minToolCount = opts?.minToolCount ?? 1;
  if (turn.inferenceNs <= 0) {
    throw new Error(`turn ${turn.turnId}: expected inferenceNs > 0, got ${turn.inferenceNs}`);
  }
  if (turn.toolCount < minToolCount) {
    throw new Error(
      `turn ${turn.turnId}: expected toolCount >= ${minToolCount} when tools ran, got ${turn.toolCount}`,
    );
  }
  if (turn.toolNs <= 0) {
    throw new Error(`turn ${turn.turnId}: expected toolNs > 0 when tools ran, got ${turn.toolNs}`);
  }
}

/**
 * Assert a < b for relative magnitude checks (e.g. TTFT < stream wall).
 * Values are plain numbers (typically nanoseconds from rollup).
 */
export function assertLessThan(left: number, right: number, label = "magnitude"): void {
  if (!(left < right)) {
    throw new Error(`${label}: expected ${left} < ${right}`);
  }
}

/**
 * Assert a phase summary exists in a rollupByPhase result and has count >= minCount.
 */
export function assertPhaseSummary(
  phases: readonly PhaseSummary[],
  phaseName: SpanName | string,
  opts?: { minCount?: number; minTotalNs?: number },
): PhaseSummary {
  const phase = phases.find((p) => p.name === phaseName);
  if (phase === undefined) {
    const names = phases.map((p) => p.name).join(", ");
    throw new Error(`expected phase summary "${phaseName}"; present: [${names || "none"}]`);
  }
  const minCount = opts?.minCount ?? 1;
  if (phase.count < minCount) {
    throw new Error(`phase "${phaseName}": expected count >= ${minCount}, got ${phase.count}`);
  }
  if (opts?.minTotalNs !== undefined && phase.totalNs < opts.minTotalNs) {
    throw new Error(
      `phase "${phaseName}": expected totalNs >= ${opts.minTotalNs}, got ${phase.totalNs}`,
    );
  }
  return phase;
}

/** Span duration helper re-export for eval scripts that only import assertions. */
export { spanDurationNs };
