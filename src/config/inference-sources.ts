import { randomUUID } from "node:crypto";
import type { InferenceSource } from "@intx/types/runtime";
import {
  buildCodexSource,
  buildOpenAISource,
  buildXaiSource,
  type ProviderCatalogEntry,
} from "./index.js";
import type {
  ProviderTier,
  Settings,
  TierAssignment,
  TierDefinition,
  TierProviderRef,
  TierSelectionMode,
} from "./settings.js";
import { PROVIDER_TIERS, resolveTierDefinition, tierDefinitionAt } from "./settings.js";
import type { ReasoningEffort } from "../provider/reasoning-effort.js";
import { SOURCE_MAX_TOKENS } from "./index.js";

export type BuildSourceContext = {
  sessionId: string;
  reasoningEffort?: ReasoningEffort;
  catalog: readonly ProviderCatalogEntry[];
};

function refKey(ref: TierProviderRef): string {
  return `${ref.provider}\0${ref.model}`;
}

export function normalizeTierDefinition(
  raw: TierAssignment | TierDefinition | undefined,
): TierDefinition | undefined {
  if (raw === undefined) return undefined;
  if ("order" in raw && Array.isArray(raw.order)) {
    const def = raw as TierDefinition;
    return {
      mode: def.mode ?? "prefer",
      order: def.order.filter((r) => r.provider.length > 0 && r.model.length > 0),
    };
  }
  const leg = raw as TierAssignment;
  if (leg.provider.length === 0 || leg.model.length === 0) return undefined;
  return { mode: "pin", order: [{ provider: leg.provider, model: leg.model }] };
}

function preferTailFromSettings(
  settings: Settings,
  existing: readonly TierProviderRef[],
): TierProviderRef[] {
  const seenProviders = new Set(existing.map((r) => r.provider));
  const tail: TierProviderRef[] = [];
  for (const [provider, p] of Object.entries(settings.providers)) {
    if (seenProviders.has(provider)) continue;
    const model = p.defaultModel ?? p.models[0];
    if (model === undefined || model.length === 0) continue;
    seenProviders.add(provider);
    tail.push({ provider, model });
  }
  return tail;
}

export function tierProviderRefs(
  tier: ProviderTier,
  settings: Settings | undefined,
  options?: { fallbackChain?: boolean },
): TierProviderRef[] {
  if (settings === undefined) return [];
  const def =
    options?.fallbackChain === true
      ? resolveTierDefinition(tier, settings)
      : tierDefinitionAt(tier, settings);
  if (def === null) return [];
  const head = def.order;
  if (def.mode === "pin") return head;
  return [...head, ...preferTailFromSettings(settings, head)];
}

function catalogEntry(
  catalog: readonly ProviderCatalogEntry[],
  provider: string,
): ProviderCatalogEntry | undefined {
  return catalog.find((e) => e.name === provider);
}

function maxTokensFor(
  settings: Settings | undefined,
  provider: string,
  model: string,
): number {
  const cw = settings?.providers[provider]?.contextWindow;
  if (typeof cw === "number" && cw > 0) return cw;
  return SOURCE_MAX_TOKENS;
}

export function buildInferenceSourceForRef(
  ref: TierProviderRef,
  ctx: BuildSourceContext,
  settings: Settings | undefined,
): InferenceSource | null {
  const entry = catalogEntry(ctx.catalog, ref.provider);
  const providerSettings = settings?.providers[ref.provider];
  const baseURL = entry?.baseURL ?? providerSettings?.baseURL;
  if (baseURL === undefined) return null;

  const maxTokens = maxTokensFor(settings, ref.provider, ref.model);
  const effort = ctx.reasoningEffort;

  if (entry?.codexProfile !== undefined) {
    return buildCodexSource({
      id: ref.provider,
      apiKey: entry.apiKey ?? "",
      model: ref.model,
      sessionId: ctx.sessionId,
      ...(entry.codexAccountId !== undefined ? { accountId: entry.codexAccountId } : {}),
      ...(effort !== undefined ? { reasoningEffort: effort } : {}),
    });
  }
  if (entry?.xaiProfile !== undefined) {
    return buildXaiSource({
      id: ref.provider,
      apiKey: entry.apiKey ?? "",
      model: ref.model,
    });
  }

  const src = buildOpenAISource({
    id: ref.provider,
    baseURL,
    ...(entry?.apiKey !== undefined
      ? { apiKey: entry.apiKey }
      : providerSettings?.apiKey !== undefined
        ? { apiKey: providerSettings.apiKey }
        : {}),
    model: ref.model,
    ...(effort !== undefined ? { reasoningEffort: effort } : {}),
  });
  return {
    ...src,
    defaults: { ...src.defaults, maxTokens },
  };
}

export function buildSourcesFromRefs(
  refs: readonly TierProviderRef[],
  ctx: BuildSourceContext,
  settings: Settings | undefined,
): InferenceSource[] {
  const out: InferenceSource[] = [];
  const seenIds = new Set<string>();
  for (const ref of refs) {
    const src = buildInferenceSourceForRef(ref, ctx, settings);
    if (src === null) continue;
    if (seenIds.has(src.id)) continue;
    seenIds.add(src.id);
    out.push(src);
  }
  return out;
}

export function prependActiveRef(
  refs: readonly TierProviderRef[],
  active: TierProviderRef,
): TierProviderRef[] {
  const without = refs.filter((r) => refKey(r) !== refKey(active));
  return [active, ...without];
}

function buildTieredSourceBundle(args: {
  settings: Settings | undefined;
  catalog: readonly ProviderCatalogEntry[];
  tier: ProviderTier;
  head: TierProviderRef;
  reasoningEffort?: ReasoningEffort;
  sessionId: string;
  fallbackChain: boolean;
}): { sources: InferenceSource[]; defaultSource: string } {
  const ctx: BuildSourceContext = {
    sessionId: args.sessionId,
    catalog: args.catalog,
    ...(args.reasoningEffort !== undefined ? { reasoningEffort: args.reasoningEffort } : {}),
  };

  const tierRefs = tierProviderRefs(args.tier, args.settings, { fallbackChain: args.fallbackChain });
  const refs = tierRefs.length > 0 ? prependActiveRef(tierRefs, args.head) : [args.head];

  const sources = buildSourcesFromRefs(refs, ctx, args.settings);
  const defaultId = args.head.provider;
  if (sources.length === 0) {
    const fallback = buildInferenceSourceForRef(args.head, ctx, args.settings);
    if (fallback === null) {
      throw new Error(`No inference source for provider "${defaultId}"`);
    }
    return { sources: [fallback], defaultSource: fallback.id };
  }
  const hasDefault = sources.some((s) => s.id === defaultId);
  return {
    sources,
    defaultSource: hasDefault ? defaultId : (sources[0]?.id ?? defaultId),
  };
}

export function buildMainSessionSources(args: {
  settings: Settings | undefined;
  catalog: readonly ProviderCatalogEntry[];
  activeProvider: string;
  activeModel: string;
  reasoningEffort?: ReasoningEffort;
  sessionId: string;
}): { sources: InferenceSource[]; defaultSource: string } {
  return buildTieredSourceBundle({
    settings: args.settings,
    catalog: args.catalog,
    tier: "standard",
    head: { provider: args.activeProvider, model: args.activeModel },
    sessionId: args.sessionId,
    fallbackChain: false,
    ...(args.reasoningEffort !== undefined ? { reasoningEffort: args.reasoningEffort } : {}),
  });
}

export function buildSubagentSources(args: {
  settings: Settings | undefined;
  catalog: readonly ProviderCatalogEntry[];
  tier: ProviderTier;
  head: TierProviderRef;
  reasoningEffort?: ReasoningEffort;
  sessionId?: string;
}): { sources: InferenceSource[]; defaultSource: string } {
  return buildTieredSourceBundle({
    settings: args.settings,
    catalog: args.catalog,
    tier: args.tier,
    head: args.head,
    sessionId: args.sessionId ?? randomUUID(),
    fallbackChain: true,
    ...(args.reasoningEffort !== undefined ? { reasoningEffort: args.reasoningEffort } : {}),
  });
}

export function firstTierRef(
  tier: ProviderTier,
  settings: Settings | undefined,
): TierProviderRef | null {
  const refs = tierProviderRefs(tier, settings);
  return refs[0] ?? null;
}

export function tierModeLabel(mode: TierSelectionMode | undefined): string {
  return mode === "pin" ? "pin" : "prefer";
}

export function formatTierChain(raw: TierDefinition | TierAssignment | undefined): string {
  const normalized = normalizeTierDefinition(raw);
  if (normalized === undefined || normalized.order.length === 0) return "unset";
  const chain = normalized.order.map((r) => `${r.provider}/${r.model}`).join(" → ");
  return `[${tierModeLabel(normalized.mode)}] ${chain}`;
}

export function appendTierEntry(
  existing: TierDefinition | TierAssignment | undefined,
  entry: TierProviderRef,
  mode?: TierSelectionMode,
): TierDefinition {
  const base = normalizeTierDefinition(existing) ?? { mode: mode ?? "prefer", order: [] };
  const without = base.order.filter((r) => refKey(r) !== refKey(entry));
  return {
    mode: mode ?? base.mode ?? "prefer",
    order: [entry, ...without],
  };
}

function tierDefinitionWithOrder(
  base: TierDefinition,
  order: TierProviderRef[],
): TierDefinition {
  const mode: TierSelectionMode = base.mode ?? "prefer";
  return { mode, order };
}

export function cycleTierMode(existing: TierDefinition | TierAssignment | undefined): TierDefinition {
  const base = normalizeTierDefinition(existing) ?? { mode: "prefer", order: [] };
  const next: TierSelectionMode = base.mode === "pin" ? "prefer" : "pin";
  return tierDefinitionWithOrder({ ...base, mode: next }, base.order);
}

export function removeTierLeg(
  existing: TierDefinition | TierAssignment | undefined,
  legIndex: number,
): TierDefinition | undefined {
  const base = normalizeTierDefinition(existing);
  if (base === undefined || legIndex < 0 || legIndex >= base.order.length) return base;
  const order = base.order.filter((_, i) => i !== legIndex);
  if (order.length === 0) return undefined;
  return tierDefinitionWithOrder(base, order);
}

export function moveTierLeg(
  existing: TierDefinition | TierAssignment | undefined,
  legIndex: number,
  direction: -1 | 1,
): TierDefinition | undefined {
  const base = normalizeTierDefinition(existing);
  if (base === undefined) return undefined;
  const target = legIndex + direction;
  if (target < 0 || target >= base.order.length) return base;
  const order = [...base.order];
  const tmp = order[legIndex];
  const swap = order[target];
  if (tmp === undefined || swap === undefined) return base;
  order[legIndex] = swap;
  order[target] = tmp;
  return tierDefinitionWithOrder(base, order);
}

export { PROVIDER_TIERS };