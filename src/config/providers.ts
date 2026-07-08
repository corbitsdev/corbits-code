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
  const entry: ProviderCatalogEntry = {
    name: submission.name,
    baseURL: submission.baseURL,
    ...(keyless ? { keyless: true } : {}),
    ...(apiKey !== undefined && apiKey.length > 0 ? { apiKey } : {}),
    models: submission.models,
    ...(submission.defaultModel !== undefined ? { defaultModel: submission.defaultModel } : {}),
    ...(submission.bifrostVirtualKey === true ? { bifrostVirtualKey: true } : {}),
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
