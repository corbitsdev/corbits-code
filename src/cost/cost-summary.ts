// Pure formatting layer over the cost/token counters already tracked in
// the stream layer. Kept free of renderer deps so the status bar segments and the
// /cost command output can be unit tested without rendering anything.

import { contextWindowFor } from "../provider/context-window.js";
import { costHiddenReason, type CostHiddenReason } from "./cost-visibility.js";
import type { PricingCache } from "./pricing-fetcher.js";

export type CostSummaryInput = {
  modelId: string;
  baseURL?: string | undefined;
  providerFree?: boolean | undefined;
  pricingCache: PricingCache | null;
  totalCost: number;
  formattedCost: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  contextTokens: number;
};

export type CostSummary = CostSummaryInput & {
  costHiddenReason: CostHiddenReason | null;
  contextWindow: number;
  // Null when the model's context window is unknown (non-positive), so the
  // display can distinguish "unknown" from a genuine 0% usage.
  contextPercentUsed: number | null;
};

export function buildCostSummary(input: CostSummaryInput): CostSummary {
  const contextWindow = contextWindowFor(input.modelId);
  const contextPercentUsed = contextWindow > 0
    ? Math.min(100, Math.round((input.contextTokens / contextWindow) * 100))
    : null;

  return {
    ...input,
    costHiddenReason: costHiddenReason({
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
  // Integer 0–100, or null when the window is unknown — drives meter color.
  contextPercentUsed: number | null;
};

function formatContextPercent(percent: number | null): string {
  return percent === null ? "--%" : `${String(percent)}%`;
}

// Status bar space is tight, so cost is omitted entirely (not shown as $0 or
// "hidden") when a hide reason applies; context usage always shows since it
// is meaningful regardless of pricing. Percent is forwarded so the bar can
// color the compact meter without re-parsing the label.
export function formatStatusBarSegments(summary: CostSummary): StatusBarCostSegments {
  return {
    ...(summary.costHiddenReason === null ? { costLabel: summary.formattedCost } : {}),
    contextLabel: `Ctx ${formatContextPercent(summary.contextPercentUsed)}`,
    contextPercentUsed: summary.contextPercentUsed,
  };
}

const HIDDEN_REASON_TEXT: Record<CostHiddenReason, string> = {
  "provider-free": "provider marked free",
  "coding-plan": "coding-plan endpoint",
  "free-model": "free model",
  "zero-priced": "zero-priced in the pricing registry",
};

export function formatCostCommandOutput(summary: CostSummary): string {
  const window = summary.contextWindow > 0 ? String(summary.contextWindow) : "unknown";
  const lines = [
    `Model: ${summary.modelId}`,
    summary.costHiddenReason === null
      ? `Cost: ${summary.formattedCost}`
      : `Cost: hidden (${HIDDEN_REASON_TEXT[summary.costHiddenReason]})`,
    `Tokens: ${String(summary.inputTokens)} in / ${String(summary.outputTokens)} out / ${String(summary.cacheReadTokens)} cache-read`,
    `Context: ${String(summary.contextTokens)}/${window} (${formatContextPercent(summary.contextPercentUsed)})`,
  ];
  return lines.join("\n");
}
