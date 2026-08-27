/**
 * Provider/model catalog → model picker options for OpenTUI product host.
 *
 * Pure: maps config.providers (record or array) into `{ id, label }[]` for
 * openModelPickerOverlay / ProductHostConfig.models. Recent/favorites refs and
 * the Go-on-Zen billing predicate are also plain data — callers own settings
 * and config loading.
 *
 * Identity is `provider:model` (matches runner active-model string).
 */

import { isGoModelOnZenPath as defaultIsGoModelOnZenPath } from "../provider/billing-product.js";
import { getActivePricingCache } from "../cost/cost-visibility.js";
import { lookupModelPricing, type PricingCache } from "../cost/pricing-fetcher.js";
import { contextWindowFor, hasContextWindowFor } from "../provider/context-window.js";
import { modelReasoningCapability } from "../provider/reasoning-effort.js";
import type { ItemDescription } from "./shell.js";

export type ModelCatalogSection = "recent" | "favorites" | "provider";

/** Picker row — superset of ProductHostModelOption (`id`, `label`). */
export interface ModelCatalogOption {
  readonly id: string;
  readonly label: string;
  readonly section?: ModelCatalogSection;
  /** Cross-product billing warning (e.g. Go model on a Zen-billed path). */
  readonly warning?: string;
}

/** Array-shaped provider (ModelPickerProvider / catalog entry subset). */
export interface ModelCatalogProvider {
  readonly name: string;
  readonly models: readonly string[];
  /** Display name for the provider bucket (falls back to `name`). */
  readonly label?: string;
  readonly baseURL?: string;
  readonly opencodeGo?: boolean;
}

/** settings.providers value subset — models list only. */
export interface ModelCatalogProviderSettings {
  readonly models?: readonly string[];
  readonly name?: string;
  readonly label?: string;
  readonly baseURL?: string;
  readonly opencodeGo?: boolean;
}

/** provider+model identity — matches config/settings.js ModelRef. */
export interface ModelCatalogRef {
  readonly provider: string;
  readonly model: string;
}

export type ModelCatalogProvidersInput =
  readonly ModelCatalogProvider[] | Readonly<Record<string, ModelCatalogProviderSettings>>;

/**
 * Flatten providers into picker options.
 *
 * - Array: each `{ name, models, label? }` expands one row per model.
 * - Record: keys are provider names; values supply `models` (+ optional label).
 *
 * Empty / missing model lists are skipped. Stable order: provider order then
 * model order within each provider. Dedupes by id.
 */
export function buildModelCatalog(providers: ModelCatalogProvidersInput): ModelCatalogOption[] {
  const entries = normalizeProviders(providers);
  const seen = new Set<string>();
  const out: ModelCatalogOption[] = [];

  for (const p of entries) {
    const providerLabel =
      p.label !== undefined && p.label.trim().length > 0 ? p.label.trim() : p.name;
    for (const model of p.models) {
      const m = model.trim();
      if (m.length === 0) continue;
      const id = modelOptionId(p.name, m);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        label: formatModelPickerLabel(m, providerLabel),
      });
    }
  }

  return out;
}

/** Stable id for a provider+model pair (`provider:model`). */
export function modelOptionId(provider: string, model: string): string {
  return `${provider}:${model}`;
}

/** Picker row: `model * [providerLabel]`. */
export function formatModelPickerLabel(model: string, providerLabel: string): string {
  return `${model} * [${providerLabel}]`;
}

function normalizeProviders(providers: ModelCatalogProvidersInput): ModelCatalogProvider[] {
  if (Array.isArray(providers)) {
    return providers
      .filter((p) => typeof p.name === "string" && p.name.length > 0)
      .map((p) => ({
        name: p.name,
        models: p.models ?? [],
        ...(p.label !== undefined ? { label: p.label } : {}),
        ...(p.baseURL !== undefined ? { baseURL: p.baseURL } : {}),
        ...(p.opencodeGo !== undefined ? { opencodeGo: p.opencodeGo } : {}),
      }));
  }

  const record = providers as Readonly<Record<string, ModelCatalogProviderSettings>>;
  return Object.entries(record).map(([name, settings]) => {
    const label = settings.label ?? settings.name;
    return {
      name,
      models: settings.models ?? [],
      ...(label !== undefined ? { label } : {}),
      ...(settings.baseURL !== undefined ? { baseURL: settings.baseURL } : {}),
      ...(settings.opencodeGo !== undefined ? { opencodeGo: settings.opencodeGo } : {}),
    };
  });
}

const GO_ON_ZEN_WARNING = "Go model on Zen path — billed as Zen credits";

/** Default recent-section cap (mirrors config/settings.js DEFAULT_RECENT_MODELS_SHOWN). */
const DEFAULT_RECENT_MAX = 5;

export interface BuildModelsFirstCatalogArgs {
  readonly providers: ModelCatalogProvidersInput;
  readonly recent?: readonly ModelCatalogRef[];
  readonly favorites?: readonly ModelCatalogRef[];
  /** Max recent rows (default 5). */
  readonly recentMax?: number;
  /**
   * When true for a model on a provider, attach a cross-product billing
   * warning (Go model configured on a Zen-billed path). Defaults to the real
   * billing-product detector; override in tests.
   */
  readonly isGoModelOnZenPath?: (model: string, provider: ModelCatalogProvider) => boolean;
}

function providerLabelOf(p: ModelCatalogProvider): string {
  return p.label !== undefined && p.label.trim().length > 0 ? p.label.trim() : p.name;
}

function findProviderWithModel(
  entries: readonly ModelCatalogProvider[],
  provider: string,
  model: string,
): ModelCatalogProvider | undefined {
  const p = entries.find((x) => x.name === provider);
  if (p === undefined) return undefined;
  return p.models.includes(model) ? p : undefined;
}

/**
 * Models-first picker rows: Recent (still-valid, capped) → Favorites (not
 * already in Recent) → each provider's models in provider order (skipping
 * pairs already listed). Identity is provider+model.
 */
export function buildModelsFirstCatalog(args: BuildModelsFirstCatalogArgs): ModelCatalogOption[] {
  const entries = normalizeProviders(args.providers);
  const recentMax = args.recentMax ?? DEFAULT_RECENT_MAX;
  const isGoModelOnZenPath = args.isGoModelOnZenPath ?? defaultIsGoModelOnZenPath;
  const seen = new Set<string>();
  const out: ModelCatalogOption[] = [];

  const pushRow = (
    provider: ModelCatalogProvider,
    model: string,
    section: ModelCatalogSection,
  ): boolean => {
    const id = modelOptionId(provider.name, model);
    if (seen.has(id)) return false;
    seen.add(id);
    const warning = isGoModelOnZenPath(model, provider) ? GO_ON_ZEN_WARNING : undefined;
    const label = formatModelPickerLabel(model, providerLabelOf(provider));
    out.push({
      id,
      label,
      section,
      ...(warning !== undefined ? { warning } : {}),
    });
    return true;
  };

  let recentCount = 0;
  for (const ref of args.recent ?? []) {
    if (recentCount >= recentMax) break;
    const provider = findProviderWithModel(entries, ref.provider, ref.model);
    if (provider === undefined) continue;
    if (pushRow(provider, ref.model, "recent")) recentCount += 1;
  }

  for (const ref of args.favorites ?? []) {
    const provider = findProviderWithModel(entries, ref.provider, ref.model);
    if (provider === undefined) continue;
    pushRow(provider, ref.model, "favorites");
  }

  for (const provider of entries) {
    for (const model of provider.models) {
      const m = model.trim();
      if (m.length === 0) continue;
      pushRow(provider, m, "provider");
    }
  }

  return out;
}

function formatPrice(perToken: number): string {
  const perMtok = perToken * 1_000_000;
  return `$${perMtok % 1 === 0 ? perMtok.toFixed(0) : perMtok.toFixed(2)}`;
}

/** Rough per-Mtok multiplier over the "standard" $3 input tier, for decision-relevant framing. */
const STANDARD_INPUT_PER_MTOK = 3;

function pricingImpact(pricing: PricingCache | null, model: string): string {
  const price = lookupModelPricing(pricing, model);
  if (price === null) return "Pricing unknown for this model.";
  const inputPerMtok = price.inputPricePerToken * 1_000_000;
  const ratio = inputPerMtok / STANDARD_INPUT_PER_MTOK;
  const ratioText =
    ratio >= 1.5
      ? ` — roughly ${Math.round(ratio)}x the standard tier`
      : ratio <= 0.67
        ? ` — a fraction of the standard tier`
        : "";
  return `${formatPrice(price.inputPricePerToken)} / ${formatPrice(price.outputPricePerToken)} per Mtok${ratioText}.`;
}

function whatLine(modelId: string): string {
  const bare = modelId.includes(":") ? modelId.slice(modelId.indexOf(":") + 1) : modelId;
  const reasoning = modelReasoningCapability(bare);
  const context = contextWindowFor(modelId);
  const confident = hasContextWindowFor(modelId);
  const contextText =
    context > 0
      ? `${Math.round(context / 1000)}k context${confident ? "" : " (estimated)"}`
      : "context length unknown";
  const reasoningText =
    reasoning === true
      ? "Deep reasoning"
      : reasoning === false
        ? "No extended reasoning"
        : "Reasoning support unknown";
  return `${reasoningText}. ${contextText}.`;
}

/**
 * Description-zone content for a picker row. `pricing` defaults to the live
 * models.dev cache; override in tests. Rows with a billing warning override
 * the plain what/impact pair.
 */
export function describeModelCatalogOption(
  option: ModelCatalogOption,
  args?: {
    readonly pricing?: PricingCache | null;
  },
): ItemDescription | null {
  const model = option.id.slice(option.id.indexOf(":") + 1);
  const pricing = args?.pricing !== undefined ? args.pricing : getActivePricingCache();

  if (option.warning !== undefined) {
    return {
      what: whatLine(option.id),
      impact:
        "A Go model reached over the Zen path. Billed as Zen credits, not your Go subscription.",
      tone: "consequence",
    };
  }

  return {
    what: whatLine(option.id),
    impact: pricingImpact(pricing, model),
    tone: "plain",
  };
}
