import type { InferenceSource } from "@intx/types/runtime";

import { getValidCodexToken } from "../auth/codex/session.js";
import { getValidXaiToken } from "../auth/xai/session.js";
import type { ProviderCatalogEntry } from "../config/index.js";
import { codexProfileFromProviderName } from "../config/codex-providers.js";
import { xaiProfileFromProviderName } from "../config/xai-providers.js";

// Sub-agents run their own reactor loop and do not inherit the TUI runner's
// refreshCodexBeforeSend hook. Refresh OAuth access tokens immediately before
// the first inference call so stale catalog snapshots do not surface as 401s.
export async function ensureFreshInferenceSource(
  source: InferenceSource,
  catalog: readonly ProviderCatalogEntry[] | undefined,
): Promise<InferenceSource> {
  const entry = catalog?.find((e) => e.name === source.id);
  const codexProfile = entry?.codexProfile ?? codexProfileFromProviderName(source.id);
  if (codexProfile !== undefined) {
    const { access } = await getValidCodexToken(codexProfile);
    return { ...source, apiKey: access };
  }
  const xaiProfile = entry?.xaiProfile ?? xaiProfileFromProviderName(source.id);
  if (xaiProfile !== undefined) {
    const { access } = await getValidXaiToken(xaiProfile);
    return { ...source, apiKey: access };
  }
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