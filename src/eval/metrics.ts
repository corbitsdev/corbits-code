import type { TokenUsage } from "@intx/types/runtime";

import { lookupModelPricing, type PricingCache } from "../pricing-fetcher.js";
import type { Cost, PriceOverride, RunMetrics } from "./types.js";

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
// LLM run-to-run variance does not swamp the comparison. Numeric fields take the
// median; `passed` takes the majority; cost stays "unknown" if any run was
// unknown (so an unpriced model never looks priced).
export function medianMetrics(runs: RunMetrics[]): RunMetrics {
  if (runs.length === 0) throw new Error("medianMetrics requires at least one run");
  const first = runs[0]!;
  const passes = runs.filter((r) => r.passed).length;
  const anyUnknownCost = runs.some((r) => !r.cost.known);
  const knownCosts = runs.filter((r) => r.cost.usd !== null).map((r) => r.cost.usd!);

  return {
    task: first.task,
    variant: first.variant,
    turns: median(runs.map((r) => r.turns)),
    toolCalls: median(runs.map((r) => r.toolCalls)),
    // Tool-type histogram is taken from the median-turns run for readability
    // rather than averaging fractional counts across runs.
    toolCallsByType: first.toolCallsByType,
    tokens: first.tokens,
    totalTokens: median(runs.map((r) => r.totalTokens)),
    cost: anyUnknownCost
      ? { known: false, usd: null }
      : { known: true, usd: median(knownCosts) },
    wallClockMs: median(runs.map((r) => r.wallClockMs)),
    passed: passes * 2 >= runs.length,
  };
}
