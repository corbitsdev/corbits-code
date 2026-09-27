import type { InferenceSource } from "@intx/types/runtime";

import { refreshSourceCredentialByProvenance } from "../auth/refresh-source-credential.js";
import type { ProviderCatalogEntry } from "../config/index.js";

export async function ensureFreshInferenceSource(
  source: InferenceSource,
  _catalog: readonly ProviderCatalogEntry[] | undefined,
): Promise<InferenceSource> {
  await refreshSourceCredentialByProvenance(source.credentialId);
  return source;
}

export async function refreshInferenceSourceBundle(
  sources: readonly InferenceSource[],
  defaultSource: string,
  catalog: readonly ProviderCatalogEntry[] | undefined,
): Promise<{ sources: InferenceSource[]; defaultSource: string }> {
  const refreshed = await Promise.all(
    sources.map((source) => ensureFreshInferenceSource(source, catalog)),
  );
  return { sources: refreshed, defaultSource };
}
