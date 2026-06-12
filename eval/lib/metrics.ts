import type { TokenUsage } from "@intx/types/runtime";

import { lookupModelPricing, type PricingCache } from "../../src/cost/pricing-fetcher.js";
import type { Cost, JudgeScores, PriceOverride, RunMetrics } from "./types.js";

// Cost from token usage. Returns { known: false, usd: null } when the model is
// unknown to the pricing source and no override is supplied — surfacing "pricing
// unknown" instead of a misleading $0.00. Kept pure so it is unit-testable
// without a live run.
export function computeCost(
  usage: TokenUsage,
  modelId: string,
  pricingCache: PricingCache | null,
  override?: PriceOverride,
): Cost {
  const pricing = override ?? lookupModelPricing(pricingCache, modelId);
  if (pricing === null) {
    return { known: false, usd: null };
  }
  const cacheReadPrice = pricing.cacheReadPricePerToken ?? 0;
  const usd =
    usage.input * pricing.inputPricePerToken +
    usage.output * pricing.outputPricePerToken +
    usage.cacheRead * cacheReadPrice;
  return { known: true, usd };
}

// Count tool calls per tool name across a run's turns.
export function tallyToolCalls(
  turns: ReadonlyArray<{ toolCalls: ReadonlyArray<{ name: string }> }>,
): Record<string, number> {
  const byType: Record<string, number> = {};
  for (const turn of turns) {
    for (const call of turn.toolCalls) {
      byType[call.name] = (byType[call.name] ?? 0) + 1;
    }
  }
  return byType;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

// Collapse N runs of the same (task, variant) into one representative result so
// LLM run-to-run variance does not swamp the comparison.
//
// To keep the reported fields internally consistent (so the token breakdown
// can't disagree with the headline token total), we pick a single representative
// run — the one whose turn count is the median — and report its per-run fields
// (turns, tool calls + histogram, tokens, wall-clock). Only the cross-run
// verdicts are recomputed: `passed`/`completedCleanly` by majority, and cost
// stays "unknown" if ANY run was unpriced so an unpriced model never looks
// priced.
export function medianMetrics(runs: RunMetrics[]): RunMetrics {
  if (runs.length === 0) throw new Error("medianMetrics requires at least one run");
  const medianTurns = median(runs.map((r) => r.turns));
  // The run closest to the median turn count is the representative.
  const representative = [...runs].sort(
    (a, b) => Math.abs(a.turns - medianTurns) - Math.abs(b.turns - medianTurns),
  )[0]!;

  const majority = (predicate: (r: RunMetrics) => boolean): boolean =>
    runs.filter(predicate).length * 2 >= runs.length;

  // Flat-fee is a property of the provider, not the run, so it survives the
  // collapse; otherwise cost stays "unknown" if any run was unpriced.
  const cost = runs.some((r) => r.cost.flatFee === true)
    ? { known: false, usd: null, flatFee: true }
    : runs.some((r) => !r.cost.known)
      ? { known: false, usd: null }
      : representative.cost;

  return {
    ...representative,
    cost,
    judge: aggregateJudge(runs),
    passed: majority((r) => r.passed),
    completedCleanly: majority((r) => r.completedCleanly),
  };
}

// The judge is a high-variance LLM signal, so collapse it across runs the same
// way the rest of the metrics are — per-dimension median over the runs that were
// actually judged — rather than inheriting whichever run happened to be the
// turn-count representative. Null if no run produced a score.
function aggregateJudge(runs: RunMetrics[]): JudgeScores | null {
  const judged = runs.map((r) => r.judge).filter((j): j is JudgeScores => j !== null);
  if (judged.length === 0) return null;
  return {
    correctness: median(judged.map((j) => j.correctness)),
    scope: median(judged.map((j) => j.scope)),
    quality: median(judged.map((j) => j.quality)),
    overall: median(judged.map((j) => j.overall)),
    // The representative rationale (first judged run); rationales don't merge.
    rationale: judged[0]!.rationale,
  };
}
