import { randomUUID } from "node:crypto";
import type { InferenceSource } from "@intx/types/runtime";
import {
  buildBifrostSource,
  buildCodexSource,
  buildGoSource,
  buildMetaSource,
  buildZenSource,
  buildAnthropicSource,
  buildOpenAISource,
  buildXaiSource,
  type ProviderCatalogEntry,
} from "./index.js";
import {
  OPENAI_API_BASE_URL,
  firstClassProviderById,
} from "../../packages/first-class-providers/src/index.js";
import { normalizeOpenAICompatibleBaseURL, type Settings } from "./settings.js";
import {
  resolveSessionEffort,
  type ReasoningEffort,
} from "../provider/reasoning-effort.js";
import { isOpenCodeGoProvider } from "../../packages/opencode-go/src/index.js";
import { isZenProvider } from "../../packages/zen/src/index.js";
import { customReasoningSettings } from "./providers.js";

export interface BuildSourceContext {
  sessionId: string;
  reasoningEffort?: ReasoningEffort;
  catalog: readonly ProviderCatalogEntry[];
}

// A resolved provider+model with optional reasoning effort.
export interface ProviderRef {
  provider: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
}

function catalogEntry(
  catalog: readonly ProviderCatalogEntry[],
  provider: string,
): ProviderCatalogEntry | undefined {
  return catalog.find((e) => e.name === provider);
}

// First-party OpenAI reasoning models reject `max_tokens` and require
// `max_completion_tokens`. The requirement is declared per model on the
// first-class OpenAI API-key path's `maxCompletionTokensModels` field — never
// inferred from name prefixes — and read here through that entry. The quirk
// follows the first-party endpoint, so relays serving the same model names
// through the same adapter keep `max_tokens`.
function openAIAPIPathMaxCompletionTokensModels(): readonly string[] {
  return (
    firstClassProviderById("openai")?.paths?.find((p) => p.id === "api")
      ?.maxCompletionTokensModels ?? []
  );
}

function openAISourceQuirks(
  baseURL: string,
  model: string,
): Record<string, unknown> | undefined {
  const normalized = normalizeOpenAICompatibleBaseURL(baseURL);
  if (normalized !== normalizeOpenAICompatibleBaseURL(OPENAI_API_BASE_URL)) {
    return undefined;
  }
  if (!openAIAPIPathMaxCompletionTokensModels().includes(model)) {
    return undefined;
  }
  return { maxTokensField: "max_completion_tokens" };
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

  const configured = ref.reasoningEffort ?? ctx.reasoningEffort;
  // The provider-declared effort ladder is honored ONLY on the plain
  // openai-compatible fall-through at the bottom (where a custom provider
  // lands). The special builders above resolve against the family table,
  // never an operator ladder, so a hand-edited settings.json row on those
  // providers cannot leak custom-form fields into them.
  const effort =
    configured !== undefined
      ? resolveSessionEffort(
          ref.model,
          configured,
          entry?.codexProfile !== undefined,
        )
      : undefined;

  if (entry?.codexProfile !== undefined) {
    return buildCodexSource({
      id: ref.provider,
      profile: entry.codexProfile,
      apiKey: entry.apiKey ?? "",
      model: ref.model,
      sessionId: ctx.sessionId,
      ...(entry.codexAccountId !== undefined
        ? { accountId: entry.codexAccountId }
        : {}),
      ...(effort !== undefined ? { reasoningEffort: effort } : {}),
    });
  }
  if (entry?.xaiProfile !== undefined) {
    return buildXaiSource({
      id: ref.provider,
      profile: entry.xaiProfile,
      apiKey: entry.apiKey ?? "",
      model: ref.model,
      sessionId: ctx.sessionId,
      ...(effort !== undefined ? { reasoningEffort: effort } : {}),
    });
  }
  if (entry?.metaProfile !== undefined) {
    return buildMetaSource({
      id: ref.provider,
      profile: entry.metaProfile,
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
  if (
    isZenProvider({
      name: ref.provider,
      ...(baseURL !== undefined ? { baseURL } : {}),
    })
  ) {
    return buildZenSource({
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
    return buildBifrostSource({
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
  }

  const quirks = openAISourceQuirks(baseURL, ref.model);
  // Custom OpenAI-compatible providers (the manual form) land here. Honor the
  // operator-declared ladder + default only on this branch — the special
  // builders above already returned with the family-table `effort`.
  const reasoning = customReasoningSettings(
    ref.provider,
    providerSettings,
    entry,
  );
  const customEffort =
    configured !== undefined || reasoning !== undefined
      ? resolveSessionEffort(
          ref.model,
          configured,
          false,
          reasoning?.reasoningEfforts,
          reasoning?.defaultReasoningEffort,
        )
      : undefined;
  // A cleared sampling field must not revive its stale catalog value.
  const inferenceOptions = providerSettings ?? entry;
  const maxTokens = inferenceOptions?.maxTokens;
  const temperature = inferenceOptions?.temperature;
  const topP = inferenceOptions?.topP;
  return buildOpenAISource({
    id: ref.provider,
    baseURL,
    ...(entry?.apiKey !== undefined
      ? { apiKey: entry.apiKey }
      : providerSettings?.apiKey !== undefined
        ? { apiKey: providerSettings.apiKey }
        : {}),
    model: ref.model,
    ...(customEffort !== undefined ? { reasoningEffort: customEffort } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { topP } : {}),
    ...(quirks !== undefined ? { quirks } : {}),
  });
}

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
    ...(args.reasoningEffort !== undefined
      ? { reasoningEffort: args.reasoningEffort }
      : {}),
  };

  const source = buildInferenceSourceForRef(args.head, ctx, args.settings);
  if (source === null) {
    throw new Error(
      `Unable to build inference source for selected provider "${args.head.provider}"`,
    );
  }
  return { sources: [source], defaultSource: source.id };
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
    ...(args.reasoningEffort !== undefined
      ? { reasoningEffort: args.reasoningEffort }
      : {}),
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
    ...(args.reasoningEffort !== undefined
      ? { reasoningEffort: args.reasoningEffort }
      : {}),
  });
}
