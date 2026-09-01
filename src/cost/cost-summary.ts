// Pure formatting layer over the cost/token counters already tracked in
// the stream layer. Kept free of renderer deps so the status bar segments and the
// /cost command output can be unit tested without rendering anything.

import { contextWindowFor } from "../provider/context-window.js";
import { costHiddenReason, type CostHiddenReason } from "./cost-visibility.js";
import type { SessionBillingMix } from "./session-cost.js";
import type { PricingCache } from "./pricing-fetcher.js";

export interface CostSummaryInput {
  modelId: string;
  baseURL?: string | undefined;
  providerName?: string | undefined;
  providerFree?: boolean | undefined;
  pricingCache: PricingCache | null;
  totalCost: number;
  formattedCost: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  contextTokens: number;
  // True when contextTokens came from the local character-count estimate
  // because the provider omitted or zeroed usage on the latest turn, rather
  // than from provider-reported usage. Lets the display flag the number as
  // approximate instead of implying provider-grade precision. The caller
  // building this input owns the decision; nothing downstream re-derives it.
  contextIsEstimate: boolean;
  // Session mix from the per-turn accumulator. Absent or "none" falls back to
  // the live identity for /cost hide copy (fresh launch, post-/clear).
  sessionBillingMix?: SessionBillingMix | undefined;
  // Hidden reason of the last hidden-identity turn. Used for hidden-only /cost
  // copy so a later live metered identity does not rewrite history.
  sessionHiddenReason?: CostHiddenReason | null | undefined;
}

export type CostSummary = CostSummaryInput & {
  costHiddenReason: CostHiddenReason | null;
  sessionBillingMix: SessionBillingMix;
  contextWindow: number;
  // Null when the model's context window is unknown (non-positive), so the
  // display can distinguish "unknown" from a genuine 0% usage.
  contextPercentUsed: number | null;
};

export function buildCostSummary(input: CostSummaryInput): CostSummary {
  const contextWindow = contextWindowFor(input.modelId);
  const contextPercentUsed =
    contextWindow > 0
      ? Math.min(100, Math.round((input.contextTokens / contextWindow) * 100))
      : null;

  return {
    ...input,
    costHiddenReason: costHiddenReason({
      modelId: input.modelId,
      baseURL: input.baseURL,
      providerName: input.providerName,
      providerFree: input.providerFree,
      pricingCache: input.pricingCache,
    }),
    sessionBillingMix: input.sessionBillingMix ?? "none",
    contextWindow,
    contextPercentUsed,
  };
}

// Zero-turn sessions (fresh launch, post-/clear, post-/new) have no occupancy
// to report. Hide the meter rather than showing 0% or the new director's
// system-prompt/tool-schema overhead as if it were live usage. Cost totals
// stay untouched.
export function maskContextMeterWhenNoTurns(summary: CostSummary, turnCount: number): CostSummary {
  if (turnCount > 0) return summary;
  return { ...summary, contextPercentUsed: null, contextIsEstimate: false };
}

export interface StatusBarCostSegments {
  costLabel?: string;
  contextLabel: string;
  // Integer 0–100, or null when the window is unknown — drives meter color.
  contextPercentUsed: number | null;
}

// "~" flags a locally estimated number so the operator doesn't read it as
// provider-confirmed. The one place this rule is encoded; every renderer of
// a context percentage (status bar, prompt border, /cost output) calls this
// rather than re-deciding the prefix itself.
export function formatContextPercentLabel(percent: number | null, isEstimate: boolean): string {
  if (percent === null) return "--%";
  return `${isEstimate ? "~" : ""}${String(percent)}%`;
}

// Status bar space is tight, so cost is omitted entirely (not shown as $0 or
// "hidden") when a hide reason applies; context usage always shows since it
// is meaningful regardless of pricing. Percent is forwarded so the bar can
// color the compact meter without re-parsing the label.
export function formatStatusBarSegments(summary: CostSummary): StatusBarCostSegments {
  return {
    ...(summary.costHiddenReason === null ? { costLabel: summary.formattedCost } : {}),
    contextLabel: `Ctx ${formatContextPercentLabel(summary.contextPercentUsed, summary.contextIsEstimate)}`,
    contextPercentUsed: summary.contextPercentUsed,
  };
}

const HIDDEN_REASON_TEXT: Record<Exclude<CostHiddenReason, "chatgpt-subscription">, string> = {
  "provider-free": "provider marked free",
  "coding-plan": "coding-plan endpoint",
  "free-model": "free model",
  "zero-priced": "zero-priced in the pricing registry",
};

const MIXED_SESSION_COST_SUFFIX = " (metered portion only; session mixed billed and hidden usage)";

export function formatSessionCostCopy(args: {
  mix: SessionBillingMix;
  formattedCost: string;
  sessionHiddenReason?: CostHiddenReason | null | undefined;
  liveHiddenReason?: CostHiddenReason | null | undefined;
}): string {
  if (args.mix === "mixed") {
    return `${args.formattedCost}${MIXED_SESSION_COST_SUFFIX}`;
  }
  if (args.mix === "metered-only") {
    return args.formattedCost;
  }
  const hide =
    args.mix === "hidden-only"
      ? (args.sessionHiddenReason ?? args.liveHiddenReason ?? null)
      : (args.liveHiddenReason ?? null);
  if (hide === null) return args.formattedCost;
  if (hide === "chatgpt-subscription") {
    return "covered by ChatGPT subscription (not billed per token)";
  }
  return `hidden (${HIDDEN_REASON_TEXT[hide]})`;
}

function formatCostLine(summary: CostSummary): string {
  return `Cost: ${formatSessionCostCopy({
    mix: summary.sessionBillingMix,
    formattedCost: summary.formattedCost,
    sessionHiddenReason: summary.sessionHiddenReason,
    liveHiddenReason: summary.costHiddenReason,
  })}`;
}

export function formatCostCommandOutput(summary: CostSummary): string {
  const window = summary.contextWindow > 0 ? String(summary.contextWindow) : "unknown";
  const lines = [
    `Model: ${summary.modelId}`,
    formatCostLine(summary),
    `Tokens: ${String(summary.inputTokens)} in / ${String(summary.outputTokens)} out / ${String(summary.cacheReadTokens)} cache-read`,
    `Context: ${String(summary.contextTokens)}/${window} (${formatContextPercentLabel(summary.contextPercentUsed, summary.contextIsEstimate)})`,
  ];
  return lines.join("\n");
}
