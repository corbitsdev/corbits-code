import { OPENCODE_GO_BASE_URL } from "../../packages/opencode-go/src/index.js";
import type { ProviderCatalogEntry } from "./index.js";

export type ProviderSubmission = {
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
};

export type ProviderEntryResult =
  | { ok: true; entry: ProviderCatalogEntry; catalog: ProviderCatalogEntry[]; selectedModel: string }
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
  // the submission explicitly re-asserts them (Connect path).
  const anthropic = submission.anthropic === true || existing?.anthropic === true;
  const opencodeGo = submission.opencodeGo === true || existing?.opencodeGo === true;
  // Never persist bare Zen PAYG baseURL for a Go subscription provider.
  const baseURL = opencodeGo ? OPENCODE_GO_BASE_URL : submission.baseURL;
  const entry: ProviderCatalogEntry = {
    name: submission.name,
    baseURL,
    ...(keyless ? { keyless: true } : {}),
    ...(apiKey !== undefined && apiKey.length > 0 ? { apiKey } : {}),
    models: submission.models,
    ...(submission.defaultModel !== undefined ? { defaultModel: submission.defaultModel } : {}),
    // Form no longer exposes Bifrost; keep any previously stored flag on edit so
    // re-saving a provider does not silently drop x-bf-vk routing.
    ...(submission.bifrostVirtualKey === true || existing?.bifrostVirtualKey === true
      ? { bifrostVirtualKey: true }
      : {}),
    ...(anthropic ? { anthropic: true } : {}),
    ...(opencodeGo ? { opencodeGo: true } : {}),
  };
  const catalog = currentCatalog
    .filter((p) => p.name !== submission.name && p.name !== submission.originalName)
    .concat(entry);
  const selectedModel = entry.defaultModel ?? entry.models[0];
  if (selectedModel === undefined) {
    return { ok: false, error: "Provider must include at least one model" };
  }
  return { ok: true, entry, catalog, selectedModel };
}

export function defaultProviderAfterSave(
  submission: ProviderSubmission,
  catalog: readonly ProviderCatalogEntry[],
  currentGlobalDefault: string | undefined,
): string | undefined {
  if (currentGlobalDefault === submission.originalName) return submission.name;
  if (currentGlobalDefault !== undefined && catalog.some((p) => p.name === currentGlobalDefault)) {
    return currentGlobalDefault;
  }
  return catalog.length === 1 ? catalog[0]?.name : submission.name;
}

export function defaultProviderAfterDelete(
  deletedProvider: string,
  fallbackProvider: string,
  catalog: readonly ProviderCatalogEntry[],
  currentGlobalDefault: string | undefined,
): string | undefined {
  if (currentGlobalDefault === deletedProvider) return fallbackProvider;
  if (currentGlobalDefault !== undefined && catalog.some((p) => p.name === currentGlobalDefault)) {
    return currentGlobalDefault;
  }
  return catalog.length === 1 ? catalog[0]?.name : undefined;
}
