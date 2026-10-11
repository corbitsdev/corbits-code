// Approximate total context window (tokens) per model, used to render
// context-window occupancy in the status bar and to size compaction. Priority:
// provider settings override at config load, then models.dev metadata loaded
// at startup, then conservative per-family floors, then a common 128k window.

import type { TokenUsage } from "@intx/types/runtime";

const DEFAULT_CONTEXT_WINDOW = 128_000;

// The one place turn occupancy is computed from a provider's reported usage.
// Cache reads and writes ride on the context window (Anthropic bills and
// counts them against it) even though they are not `input` — omitting them
// understates occupancy for prompt-caching sessions. The meter and compaction
// governor must both call this so they cannot silently diverge on what
// "context size" means.
export function contextTokensFromUsage(usage: TokenUsage | undefined): number {
  if (usage === undefined) return 0;
  return usage.input + usage.cacheRead + usage.cacheWrite;
}

// Populated at startup from the models.dev pricing cache (limit.context).
// Exact model-id match wins over the family heuristics below.
let contextWindowRegistry: Record<string, number> = {};

// Populated at config load from providers.<name>.contextWindow. Survives a
// later models.dev refresh because it lives beside the registry, not in it.
let contextWindowOverrides: Record<string, number> = {};

// Both tables are wholesale-replaced on refresh; one factory keeps the two
// trivial setters from drifting. `undefined` (no cache yet) means empty.
function createRegistrySetter(
  replace: (windows: Record<string, number>) => void,
): (windows: Record<string, number> | undefined) => void {
  return (windows) => replace(windows ?? {});
}

export const setModelContextWindows = createRegistrySetter((windows) => {
  contextWindowRegistry = windows;
});

export const setProviderContextWindowOverrides = createRegistrySetter(
  (windows) => {
    contextWindowOverrides = windows;
  },
);

export type ProviderContextWindowSource = {
  models: readonly string[];
  contextWindow?: number;
};

function isPositiveWindow(window: number | undefined): window is number {
  return window !== undefined && Number.isFinite(window) && window > 0;
}

// Key `<provider>:<model>` for every model on a provider that sets the knob.
// Bare model ids are added only for the resolved provider so occupancy
// lookups that only have `source.model` still hit, without letting another
// provider's same model id steal the bare slot.
export function buildProviderContextWindowOverrides(
  providers: Record<string, ProviderContextWindowSource>,
  resolvedProviderName: string,
  resolvedModel: string,
): Record<string, number> {
  const overrides: Record<string, number> = {};
  for (const [name, provider] of Object.entries(providers)) {
    const window = provider.contextWindow;
    if (!isPositiveWindow(window)) continue;
    const models = new Set(provider.models);
    if (name === resolvedProviderName && resolvedModel.length > 0) {
      models.add(resolvedModel);
    }
    for (const model of models) {
      if (model.length === 0) continue;
      overrides[`${name}:${model}`] = window;
      if (name === resolvedProviderName) {
        overrides[model] = window;
      }
    }
  }
  return overrides;
}

function heuristicWindow(model: string): number {
  const m = model.toLowerCase();
  if (m.includes("gpt-6")) return 1_000_000;
  if (m.includes("gpt-5") || m.includes("codex")) return 400_000;
  if (m.includes("claude")) return 200_000;
  if (m.includes("gemini")) return 1_000_000;
  if (m.includes("deepseek")) return 128_000;
  if (m.includes("glm-5.3")) return 1_000_000;
  if (m.includes("glm")) return 200_000;
  if (m.includes("o3") || m.includes("o4")) return 200_000;
  if (
    m.includes("grok-4.7") ||
    m.includes("grok-4.6") ||
    m.includes("grok-4.5")
  )
    return 500_000;
  if (m.includes("grok-4.3")) return 1_000_000;
  if (m.includes("grok") || m.includes("xai")) return 256_000;
  return DEFAULT_CONTEXT_WINDOW;
}

// Model identity is `provider:model` (model-catalog.ts), and `provider` may
// be a custom account name (`xai/alice`) rather than the canonical provider
// models.dev publishes under (`xai`). Try, in order: the full identity, the
// bare model id, and `canonicalProvider/model` — so a custom-named provider
// still exact-matches the registry instead of falling through to the
// heuristic.
function lookupCandidates(model: string): string[] {
  const colonIndex = model.indexOf(":");
  if (colonIndex === -1) return [model];

  const providerSegment = model.slice(0, colonIndex);
  const bareModel = model.slice(colonIndex + 1);
  const canonicalProvider = providerSegment.split("/")[0];

  return [model, bareModel, `${canonicalProvider}/${bareModel}`];
}

function lookupWindow(
  table: Record<string, number>,
  model: string,
): number | undefined {
  for (const candidate of lookupCandidates(model)) {
    const exact = table[candidate];
    if (exact !== undefined) return exact;
  }
  return undefined;
}

/** True when an override or the registry has an entry for `model` under any
 * known form, so a caller can distinguish a confident lookup from the
 * heuristic fallback. */
export function hasContextWindowFor(model: string): boolean {
  return (
    lookupWindow(contextWindowOverrides, model) !== undefined ||
    lookupWindow(contextWindowRegistry, model) !== undefined
  );
}

export function contextWindowFor(model: string): number {
  return (
    lookupWindow(contextWindowOverrides, model) ??
    lookupWindow(contextWindowRegistry, model) ??
    heuristicWindow(model)
  );
}

// Fraction of the window at which proactive compaction fires. Kept well below
// the hard limit so summarization happens while the model still reasons well
// and before any provider rejects the request. Also the status-bar meter's
// warning threshold so the color shift matches when compaction starts.
export const COMPACTION_WINDOW_FRACTION = 0.6;

// Status-bar meter turns danger at this fraction of the window — past
// compaction and approaching hard overflow at 1.0. Inclusive integer bands
// keep 80 in warning and start danger at 81.
export const CONTEXT_METER_DANGER_FRACTION = 0.8;

// Wide resume gap after a compact: the governor does not re-arm on growth
// alone until usage climbs this fraction of the window past the post-compact
// measurement. Anchored to the meter bands — danger (0.8) minus threshold
// (0.6) — so a session that folded only marginally under the high watermark
// must climb a full warning band before another fold instead of looping a
// compact on every small growth step.
export const COMPACTION_WIDE_RESUME_FRACTION = 0.2;

export type ContextMeterBand = "quiet" | "warning" | "danger";

/**
 * Map a 0–100 context-window percent onto the meter band.
 * Inclusive: 0–60 quiet, 61–80 warning, 81–100 danger.
 */
export function contextMeterBand(percentUsed: number): ContextMeterBand {
  if (percentUsed <= 60) return "quiet";
  if (percentUsed <= 80) return "warning";
  return "danger";
}

// Token threshold at which the director should compact, sized to the model's
// real window. `model` may be undefined early in a session (no cycle yet);
// fall back to the default window.
export function compactionThresholdFor(model: string | undefined): number {
  const window =
    model !== undefined ? contextWindowFor(model) : DEFAULT_CONTEXT_WINDOW;
  return Math.floor(window * COMPACTION_WINDOW_FRACTION);
}

/** Tokens of growth past the last post-compact measurement before the
 * latched proactive path may re-arm. */
export function compactionWideResumeDeltaFor(
  model: string | undefined,
): number {
  const window =
    model !== undefined ? contextWindowFor(model) : DEFAULT_CONTEXT_WINDOW;
  return Math.floor(window * COMPACTION_WIDE_RESUME_FRACTION);
}

/** Fold evidence for restoring consecutive/overflow/non-converged rails:
 * usage back at or under the compaction threshold means the summarizing fold
 * got under. Does not drop the growth latch — re-arming still requires
 * hasWideResumeGap past the post-compact snapshot. */
export function isAtOrUnderCompactThreshold(
  contextTokens: number,
  model: string | undefined,
): boolean {
  return contextTokens <= compactionThresholdFor(model);
}

/** Shared re-arm rule for a session latched after a compact (automatic,
 * operator, or overflow recovery): growth alone never re-arms — only a wide
 * resume gap past the post-compact measurement does. The proactive threshold
 * path routes through this predicate; the overflow path shares the reset rule
 * (under-threshold folds restore the recovery budget) but fires on overflow
 * errors regardless of this latch. */
export function hasWideResumeGap(
  postCompactTokens: number,
  contextTokens: number,
  model: string | undefined,
): boolean {
  return (
    contextTokens >= postCompactTokens + compactionWideResumeDeltaFor(model)
  );
}
