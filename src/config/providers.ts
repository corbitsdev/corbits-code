import {
  OPENCODE_GO_BASE_URL,
  isOpenCodeGoProvider,
  isOpenCodeGoProviderId,
  isOpenCodeGoURL,
} from "../../packages/opencode-go/src/index.js";
import type { ReasoningEffort } from "../provider/reasoning-effort.js";
import { normalizeProviderEfforts } from "../provider/reasoning-effort.js";
import type { ProviderCatalogEntry } from "./index.js";
import type { ProviderSettings } from "./settings.js";
import { isZenProvider } from "../../packages/zen/src/index.js";

// A declaration belongs to the plain OpenAI-compatible path, not to a
// protocol-specific source that happens to carry the same settings fields.
export function customReasoningSettings(
  name: string,
  settings: ProviderSettings | undefined,
  entry?: ProviderCatalogEntry,
):
  | Pick<ProviderSettings, "reasoningEfforts" | "defaultReasoningEffort">
  | undefined {
  // Settings may already reflect an edit while asynchronous catalog discovery is pending.
  const provider = settings ?? entry;
  if (
    provider?.reasoningEfforts === undefined ||
    entry?.codexProfile !== undefined ||
    entry?.xaiProfile !== undefined ||
    entry?.anthropic === true ||
    settings?.anthropic === true ||
    entry?.bifrostVirtualKey === true ||
    settings?.bifrostVirtualKey === true ||
    isOpenCodeGoProvider({
      name,
      baseURL: provider.baseURL,
      ...(entry?.opencodeGo === true || settings?.opencodeGo === true
        ? { opencodeGo: true }
        : {}),
    }) ||
    isZenProvider({ name, baseURL: provider.baseURL })
  ) {
    return undefined;
  }
  return provider;
}

export interface ProviderSubmission {
  name: string;
  originalName?: string;
  baseURL: string;
  apiKey?: string;
  models: string[];
  defaultModel?: string;
  keyless?: boolean;
  bifrostVirtualKey?: boolean;
  anthropic?: boolean;
  opencodeGo?: boolean;
  reasoningEfforts?: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
}

// Precedence for the active/backup model of a provider: defaultModel wins
// when present and non-empty, otherwise the first configured model.
export function resolveDefaultModel(
  entry: { defaultModel?: string; models: readonly string[] } | undefined,
): string | undefined {
  const defaultModel = entry?.defaultModel;
  if (defaultModel !== undefined && defaultModel.length > 0)
    return defaultModel;
  return entry?.models[0];
}

export type ProviderEntryResult =
  | {
      ok: true;
      entry: ProviderCatalogEntry;
      catalog: ProviderCatalogEntry[];
      selectedModel: string;
    }
  | { ok: false; error: string };

export function buildProviderEntry(
  submission: ProviderSubmission,
  currentCatalog: readonly ProviderCatalogEntry[],
): ProviderEntryResult {
  const conflict = currentCatalog.find(
    (p) => p.name === submission.name && p.name !== submission.originalName,
  );
  if (conflict !== undefined) {
    return { ok: false, error: `Provider "${submission.name}" already exists` };
  }
  const existing =
    submission.originalName !== undefined
      ? currentCatalog.find((p) => p.name === submission.originalName)
      : undefined;
  const keyless = submission.keyless === true;
  const apiKey = submission.apiKey ?? (keyless ? undefined : existing?.apiKey);
  if (!keyless && (apiKey === undefined || apiKey.length === 0)) {
    return { ok: false, error: "Provider API key is required" };
  }
  // Protocol flags are not form fields — preserve catalog flags on edit unless
  // the submission explicitly re-asserts them (Connect path). Known Go ids,
  // display labels, and Go baseURLs pin even when the flag was dropped from
  // disk. Hard cutover both ways: an explicit non-Go submission baseURL
  // demotes the sticky opencodeGo pin; known first-class Go id/label still
  // pins via name identity.
  const anthropic =
    submission.anthropic === true || existing?.anthropic === true;
  const submittedBase =
    submission.baseURL.length > 0 ? submission.baseURL : undefined;
  const demoteByURL =
    submittedBase !== undefined && !isOpenCodeGoURL(submittedBase);
  const stickyGoFlag =
    !demoteByURL &&
    (submission.opencodeGo === true ||
      existing?.opencodeGo === true ||
      isOpenCodeGoProviderId(submission.originalName));
  const identityBaseURL = submittedBase ?? existing?.baseURL;
  const opencodeGo = isOpenCodeGoProvider({
    name: submission.name,
    ...(stickyGoFlag ? { opencodeGo: true as const } : {}),
    ...(identityBaseURL !== undefined ? { baseURL: identityBaseURL } : {}),
  });
  // Never persist bare Zen PAYG baseURL for a Go subscription provider.
  const baseURL = opencodeGo ? OPENCODE_GO_BASE_URL : submission.baseURL;
  const entry: ProviderCatalogEntry = {
    name: submission.name,
    baseURL,
    ...(keyless ? { keyless: true } : {}),
    ...(apiKey !== undefined && apiKey.length > 0 ? { apiKey } : {}),
    models: submission.models,
    ...(submission.defaultModel !== undefined
      ? { defaultModel: submission.defaultModel }
      : {}),
    // Form no longer exposes Bifrost; keep any previously stored flag on edit so
    // re-saving a provider does not silently drop x-bf-vk routing.
    ...(submission.bifrostVirtualKey === true ||
    existing?.bifrostVirtualKey === true
      ? { bifrostVirtualKey: true }
      : {}),
    ...(anthropic ? { anthropic: true } : {}),
    ...(opencodeGo ? { opencodeGo: true } : {}),
    ...(() => {
      const efforts = normalizeProviderEfforts(submission.reasoningEfforts);
      return {
        ...(efforts.length > 0 ? { reasoningEfforts: efforts } : {}),
        ...(submission.defaultReasoningEffort !== undefined &&
        submission.defaultReasoningEffort.length > 0
          ? { defaultReasoningEffort: submission.defaultReasoningEffort }
          : {}),
      };
    })(),
    ...(submission.maxTokens !== undefined
      ? { maxTokens: submission.maxTokens }
      : {}),
    ...(submission.temperature !== undefined
      ? { temperature: submission.temperature }
      : {}),
    ...(submission.topP !== undefined ? { topP: submission.topP } : {}),
  };
  const catalog = currentCatalog
    .filter(
      (p) => p.name !== submission.name && p.name !== submission.originalName,
    )
    .concat(entry);
  const selectedModel = resolveDefaultModel(entry);
  if (selectedModel === undefined) {
    return { ok: false, error: "Provider must include at least one model" };
  }
  return { ok: true, entry, catalog, selectedModel };
}
