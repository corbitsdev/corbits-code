// Approximate total context window (tokens) per model, used to render
// context-window occupancy in the status bar and to size compaction. When
// models.dev metadata is loaded at startup it takes priority; otherwise we fall
// back to conservative per-family floors, and finally a common 128k window.

import type { TokenUsage } from "@intx/types/runtime";

const DEFAULT_CONTEXT_WINDOW = 128_000;

// The one place "how much context is this turn occupying" gets computed from
// a provider's reported usage. Cache reads and writes still ride on the
// context window (a provider like Anthropic bills and counts them against
// it) even though they are not `input` — omitting them understates occupancy
// for any session using prompt caching. The status-bar meter and the
// compaction governor must both call this rather than hand-picking fields,
// or they silently diverge on what "context size" means.
export function contextTokensFromUsage(usage: TokenUsage | undefined): number {
  if (usage === undefined) return 0;
  return usage.input + usage.cacheRead + usage.cacheWrite;
}

// Populated at startup from the models.dev pricing cache (limit.context).
// Exact model-id match wins over the family heuristics below.
let contextWindowRegistry: Record<string, number> = {};

// Provider-level overrides for local models set via /context-size.
// Takes precedence over the model registry and heuristics.
let providerContextOverrides: Record<string, number | undefined> = {};

export function setModelContextWindows(windows: Record<string, number> | undefined): void {
  contextWindowRegistry = windows ?? {};
}

export function setProviderContextOverrides(overrides: Record<string, number> | undefined): void {
  providerContextOverrides = overrides ?? {};
}

export function setProviderContextWindow(provider: string, tokens?: number): void {
  if (tokens === undefined) {
    providerContextOverrides[provider] = undefined;
  } else {
    providerContextOverrides[provider] = tokens;
  }
}

function heuristicWindow(model: string): number {
  const m = model.toLowerCase();
  if (m.includes("gpt-5") || m.includes("codex")) return 400_000;
  if (m.includes("claude")) return 200_000;
  if (m.includes("gemini")) return 1_000_000;
  if (m.includes("deepseek")) return 128_000;
  if (m.includes("glm")) return 200_000;
  if (m.includes("o3") || m.includes("o4")) return 200_000;
  if (m.includes("grok") || m.includes("xai")) return 256_000;
  return DEFAULT_CONTEXT_WINDOW;
}

// Model identity is `provider:model` (model-catalog.ts), and `provider` may
// itself be a custom account name (`xai/thegreataxios`) rather than the
// canonical provider models.dev publishes under (`xai`). Try, in order: the
// full identity as given, the bare model id, and `canonicalProvider/model` —
// so a custom-named provider still exact-matches the registry instead of
// silently missing and falling through to the heuristic.
function providerFromModel(model: string): string | undefined {
  const colonIndex = model.indexOf(":");
  if (colonIndex === -1) return undefined;
  return model.slice(0, colonIndex);
}

function lookupCandidates(model: string): string[] {
  const colonIndex = model.indexOf(":");
  if (colonIndex === -1) return [model];

  const providerSegment = model.slice(0, colonIndex);
  const bareModel = model.slice(colonIndex + 1);
  const canonicalProvider = providerSegment.split("/")[0];

  return [model, bareModel, `${canonicalProvider}/${bareModel}`];
}

/** True when the registry has an entry for `model` under any known form, so a
 * caller can distinguish a confident lookup from the heuristic fallback. */
export function hasContextWindowFor(model: string): boolean {
  const provider = providerFromModel(model);
  if (provider !== undefined && providerContextOverrides[provider] !== undefined) {
    return true;
  }
  return lookupCandidates(model).some(
    (candidate) => contextWindowRegistry[candidate] !== undefined,
  );
}

export function contextWindowFor(model: string): number {
  const provider = providerFromModel(model);
  if (provider !== undefined && providerContextOverrides[provider] !== undefined) {
    return providerContextOverrides[provider];
  }
  for (const candidate of lookupCandidates(model)) {
    const exact = contextWindowRegistry[candidate];
    if (exact !== undefined) return exact;
  }
  return heuristicWindow(model);
}

// Fraction of the window at which proactive compaction should fire. Kept well
// below the hard limit so summarization happens while the model still reasons
// well and before any provider rejects the request. Also the status-bar meter's
// warning threshold so the color shift matches when compaction starts.
export const COMPACTION_WINDOW_FRACTION = 0.6;

// After a compact that remains over the high watermark, the governor waits for
// usage to grow by this fraction of the window before re-arming. Growth
// hysteresis, not a low watermark: dropping under 60% is not required.
export const COMPACTION_RESUME_FRACTION = 0.1;

// Status-bar meter turns danger at this fraction of the window — past
// compaction and approaching hard overflow at 1.0. Inclusive integer bands
// keep 80 in warning and start danger at 81.
export const CONTEXT_METER_DANGER_FRACTION = 0.8;

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
// real window. `model` may be undefined early in a session (no cycle yet); we
// fall back to the default window in that case.
export function compactionThresholdFor(model: string | undefined): number {
  const window = model !== undefined ? contextWindowFor(model) : DEFAULT_CONTEXT_WINDOW;
  return Math.floor(window * COMPACTION_WINDOW_FRACTION);
}

/** Tokens of growth past the last post-compact measurement before re-arming. */
export function compactionResumeDeltaFor(model: string | undefined): number {
  const window = model !== undefined ? contextWindowFor(model) : DEFAULT_CONTEXT_WINDOW;
  return Math.floor(window * COMPACTION_RESUME_FRACTION);
}
