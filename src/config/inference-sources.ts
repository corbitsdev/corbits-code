import { randomUUID } from "node:crypto";
import type { InferenceSource } from "@intx/types/runtime";
import {
  buildBifrostSource,
  buildCodexSource,
  buildGoSource,
  buildAnthropicSource,
  buildOpenAISource,
  buildXaiSource,
  type ProviderCatalogEntry,
} from "./index.js";
import type { Settings } from "./settings.js";
import { resolveSessionEffort, type ReasoningEffort } from "../provider/reasoning-effort.js";
import { SOURCE_MAX_TOKENS } from "./index.js";
import { isOpenCodeGoProvider } from "../../packages/opencode-go/src/index.js";
import { resolveDefaultModel } from "./providers.js";

export interface BuildSourceContext {
  sessionId: string;
  reasoningEffort?: ReasoningEffort;
  catalog: readonly ProviderCatalogEntry[];
}

// A resolved provider+model, with optional reasoningEffort — the unit both
// the primary source and its backups are built from.
export interface ProviderRef {
  provider: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
}

function refKey(ref: ProviderRef): string {
  return `${ref.provider}\0${ref.model}`;
}

// Every other configured provider, one model each, so a primary source that
// fails to build (bad credentials, missing baseURL) still has somewhere to
// fall back to. Order follows settings.providers; providers already covered
// by `existing` are skipped.
function backupRefsFromSettings(
  settings: Settings,
  existing: readonly ProviderRef[],
): ProviderRef[] {
  const seenProviders = new Set(existing.map((r) => r.provider));
  const tail: ProviderRef[] = [];
  for (const [provider, p] of Object.entries(settings.providers)) {
    if (seenProviders.has(provider)) continue;
    const model = resolveDefaultModel(p);
    if (model === undefined || model.length === 0) continue;
    seenProviders.add(provider);
    tail.push({ provider, model });
  }
  return tail;
}

function catalogEntry(
  catalog: readonly ProviderCatalogEntry[],
  provider: string,
): ProviderCatalogEntry | undefined {
  return catalog.find((e) => e.name === provider);
}

function maxTokensFor(settings: Settings | undefined, provider: string, _model: string): number {
  const cw = settings?.providers[provider]?.contextWindow;
  if (typeof cw === "number" && cw > 0) return cw;
  return SOURCE_MAX_TOKENS;
}

export function buildInferenceSourceForRef(
  ref: ProviderRef,
  ctx: BuildSourceContext,
  settings: Settings | undefined,
): InferenceSource | null {
  const entry = catalogEntry(ctx.catalog, ref.provider);
  const providerSettings = settings?.providers[ref.provider];
  const baseURL = entry?.baseURL ?? providerSettings?.baseURL;
  if (baseURL === undefined) return null;

  const maxTokens = maxTokensFor(settings, ref.provider, ref.model);
  const configured = ref.reasoningEffort ?? ctx.reasoningEffort;
  const effort =
    configured !== undefined
      ? resolveSessionEffort(ref.model, configured, entry?.codexProfile !== undefined)
      : undefined;

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
      sessionId: ctx.sessionId,
      ...(effort !== undefined ? { reasoningEffort: effort } : {}),
    });
  }
  if (
    isOpenCodeGoProvider({
      name: ref.provider,
      ...(entry?.opencodeGo === true || providerSettings?.opencodeGo === true
        ? { opencodeGo: true as const }
        : {}),
      ...(baseURL !== undefined ? { baseURL } : {}),
    })
  ) {
    return buildGoSource({
      id: ref.provider,
      ...(entry?.apiKey !== undefined
        ? { apiKey: entry.apiKey }
        : providerSettings?.apiKey !== undefined
          ? { apiKey: providerSettings.apiKey }
          : {}),
      model: ref.model,
      sessionId: ctx.sessionId,
      ...(effort !== undefined ? { reasoningEffort: effort } : {}),
    });
  }
  if (entry?.anthropic === true || providerSettings?.anthropic === true) {
    return buildAnthropicSource({
      id: ref.provider,
      baseURL,
      ...(entry?.apiKey !== undefined
        ? { apiKey: entry.apiKey }
        : providerSettings?.apiKey !== undefined
          ? { apiKey: providerSettings.apiKey }
          : {}),
      model: ref.model,
    });
  }
  if (entry?.bifrostVirtualKey === true) {
    const src = buildBifrostSource({
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
  refs: readonly ProviderRef[],
  ctx: BuildSourceContext,
  settings: Settings | undefined,
): InferenceSource[] {
  const out: InferenceSource[] = [];
  const seenIds = new Set<string>();
  for (const ref of refs) {
    let src: InferenceSource | null;
    try {
      src = buildInferenceSourceForRef(ref, ctx, settings);
    } catch {
      // A leftover sibling URL (e.g. Custom `/api/tags`) must not take down the
      // whole bundle. Head failure is re-checked in `buildSourceBundle`.
      continue;
    }
    if (src === null) continue;
    if (seenIds.has(src.id)) continue;
    seenIds.add(src.id);
    out.push(src);
  }
  return out;
}

export function prependActiveRef(refs: readonly ProviderRef[], active: ProviderRef): ProviderRef[] {
  const without = refs.filter((r) => refKey(r) !== refKey(active));
  return [active, ...without];
}

// Builds the primary source for `head` plus one backup per other configured
// provider, so a mid-run failure (bad credentials, dropped connection) has
// somewhere else to go. `head` always wins as defaultSource when it builds.
function buildSourceBundle(args: {
  settings: Settings | undefined;
  catalog: readonly ProviderCatalogEntry[];
  head: ProviderRef;
  reasoningEffort?: ReasoningEffort;
  sessionId: string;
}): { sources: InferenceSource[]; defaultSource: string } {
  const ctx: BuildSourceContext = {
    sessionId: args.sessionId,
    catalog: args.catalog,
    ...(args.reasoningEffort !== undefined ? { reasoningEffort: args.reasoningEffort } : {}),
  };

  const refs =
    args.settings !== undefined
      ? prependActiveRef(backupRefsFromSettings(args.settings, [args.head]), args.head)
      : [args.head];

  const sources = buildSourcesFromRefs(refs, ctx, args.settings);
  const defaultId = args.head.provider;
  const hasDefault = sources.some((s) => s.id === defaultId);
  if (!hasDefault) {
    let fallback: InferenceSource | null;
    try {
      fallback = buildInferenceSourceForRef(args.head, ctx, args.settings);
    } catch (error) {
      throw new Error(`No inference source for provider "${defaultId}"`, { cause: error });
    }
    if (fallback === null) {
      throw new Error(`No inference source for provider "${defaultId}"`);
    }
    return { sources: [fallback, ...sources], defaultSource: fallback.id };
  }
  return {
    sources,
    defaultSource: defaultId,
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
  return buildSourceBundle({
    settings: args.settings,
    catalog: args.catalog,
    head: { provider: args.activeProvider, model: args.activeModel },
    sessionId: args.sessionId,
    ...(args.reasoningEffort !== undefined ? { reasoningEffort: args.reasoningEffort } : {}),
  });
}

export function buildSubagentSources(args: {
  settings: Settings | undefined;
  catalog: readonly ProviderCatalogEntry[];
  head: ProviderRef;
  reasoningEffort?: ReasoningEffort;
  sessionId?: string;
}): { sources: InferenceSource[]; defaultSource: string } {
  return buildSourceBundle({
    settings: args.settings,
    catalog: args.catalog,
    head: args.head,
    sessionId: args.sessionId ?? randomUUID(),
    ...(args.reasoningEffort !== undefined ? { reasoningEffort: args.reasoningEffort } : {}),
  });
}
