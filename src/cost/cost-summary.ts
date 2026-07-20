// Pure formatting layer over the cost/token counters already tracked in
// use-stream.ts. Kept free of Ink/React so the status bar segments and the
// /cost command output can be unit tested without rendering anything.

import { contextWindowFor } from "../provider/context-window.js";
import { shouldHideCost } from "./cost-visibility.js";
import type { PricingCache } from "./pricing-fetcher.js";

export type CostSummaryInput = {
  modelId: string;
  baseURL?: string;
  providerFree?: boolean;
  pricingCache: PricingCache | null;
  totalCost: number;
  formattedCost: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  contextTokens: number;
};

export type CostSummary = CostSummaryInput & {
  hideCost: boolean;
  contextWindow: number;
  contextPercentUsed: number;
};

export function buildCostSummary(input: CostSummaryInput): CostSummary {
  const contextWindow = contextWindowFor(input.modelId);
  const contextPercentUsed = contextWindow > 0
    ? Math.min(100, Math.round((input.contextTokens / contextWindow) * 100))
    : 0;

  return {
    ...input,
    hideCost: shouldHideCost({
      modelId: input.modelId,
      baseURL: input.baseURL,
      providerFree: input.providerFree,
      pricingCache: input.pricingCache,
    }),
    contextWindow,
    contextPercentUsed,
  };
}

export type StatusBarCostSegments = {
  costLabel?: string;
  contextLabel: string;
};

// Status bar space is tight, so cost is omitted entirely (not shown as $0 or
// "hidden") when shouldHideCost says so; context usage always shows since it
// is meaningful regardless of pricing.
export function formatStatusBarSegments(summary: CostSummary): StatusBarCostSegments {
  return {
    ...(summary.hideCost ? {} : { costLabel: summary.formattedCost }),
    contextLabel: `Ctx ${String(summary.contextPercentUsed)}%`,
  };
}

export function formatCostCommandOutput(summary: CostSummary): string {
  const lines = [
    `Model: ${summary.modelId}`,
    summary.hideCost
      ? "Cost: hidden (free model or coding plan)"
      : `Cost: ${summary.formattedCost}`,
    `Tokens: ${String(summary.inputTokens)} in / ${String(summary.outputTokens)} out / ${String(summary.cacheReadTokens)} cache-read`,
    `Context: ${String(summary.contextTokens)}/${String(summary.contextWindow)} (${String(summary.contextPercentUsed)}%)`,
  ];
  return lines.join("\n");
}
