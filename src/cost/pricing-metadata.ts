import { setActivePricingCache } from "./cost-visibility.js";
import {
  loadPricing,
  readPricingCache,
  type PricingCache,
  type PricingFetcherOptions,
} from "./pricing-fetcher.js";
import { setModelContextWindows } from "../provider/context-window.js";
import { setModelReasoningCapabilities } from "../provider/reasoning-effort.js";

let refreshScheduled = false;

export function applyPricingCacheMetadata(cache: PricingCache | null): void {
  setModelReasoningCapabilities(cache?.reasoning ?? {});
  setModelContextWindows(cache?.contextWindows);
  setActivePricingCache(cache);
}

export async function seedPricingMetadataFromCache(
  options: PricingFetcherOptions = {},
): Promise<PricingCache | null> {
  const cached = await readPricingCache(options.cachePath);
  applyPricingCacheMetadata(cached);
  return cached;
}

export function schedulePricingMetadataRefresh(options: PricingFetcherOptions = {}): void {
  if (refreshScheduled) return;
  refreshScheduled = true;
  void loadPricing(options)
    .then((cache) => {
      if (cache !== null) applyPricingCacheMetadata(cache);
    })
    .catch(() => undefined);
}

export async function bootstrapPricingMetadata(options: PricingFetcherOptions = {}): Promise<void> {
  await seedPricingMetadataFromCache(options);
  schedulePricingMetadataRefresh(options);
}

/** Test-only: reset the one-shot refresh guard. */
export function resetPricingMetadataRefreshForTests(): void {
  refreshScheduled = false;
}