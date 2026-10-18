import {
  getActivePricingCache,
  setActivePricingCache,
} from "./cost-visibility.js";
import {
  defaultPricingCachePath,
  loadPricing,
  readPricingCache,
  type PricingCache,
  type PricingFetcherOptions,
} from "./pricing-fetcher.js";
import { setModelContextWindows } from "../provider/context-window.js";
import { setModelReasoningCapabilities } from "../provider/reasoning-effort.js";

let refreshScheduled = false;
/** Path whose cache has already been applied in this process. */
let bootPricingPath: string | undefined;
/** In-flight disk reads, shared so boot and a later seed hit the file once. */
const bootPricingReads = new Map<string, Promise<PricingCache | null>>();
/** Finished reads retained so a fast disk return is not issued twice. */
const completedPricingReads = new Map<string, PricingCache | null>();
let pricingCacheReadCount = 0;

export function applyPricingCacheMetadata(cache: PricingCache | null): void {
  setModelReasoningCapabilities(cache?.reasoning ?? {});
  setModelContextWindows(cache?.contextWindows);
  setActivePricingCache(cache);
}

function pricingCachePathOf(options: PricingFetcherOptions): string {
  return options.cachePath ?? defaultPricingCachePath();
}

function beginPricingCacheRead(
  cachePath: string,
): Promise<PricingCache | null> {
  if (completedPricingReads.has(cachePath)) {
    return Promise.resolve(completedPricingReads.get(cachePath) ?? null);
  }
  const existing = bootPricingReads.get(cachePath);
  if (existing !== undefined) return existing;
  pricingCacheReadCount += 1;
  const pending = readPricingCache(cachePath)
    .then((cache) => {
      completedPricingReads.set(cachePath, cache);
      return cache;
    })
    .finally(() => {
      bootPricingReads.delete(cachePath);
    });
  bootPricingReads.set(cachePath, pending);
  return pending;
}

/** Start the boot pricing-cache read so it overlaps other startup I/O. */
export function startPricingCacheRead(cachePath?: string): void {
  const path = cachePath ?? defaultPricingCachePath();
  if (bootPricingPath === path) return;
  beginPricingCacheRead(path);
}

export async function seedPricingMetadataFromCache(
  options: PricingFetcherOptions = {},
): Promise<PricingCache | null> {
  const cachePath = pricingCachePathOf(options);
  // Already applied for this path: keep whatever refresh has installed since,
  // and do not read the file again.
  if (bootPricingPath === cachePath) return getActivePricingCache();
  const cached = await beginPricingCacheRead(cachePath);
  if (bootPricingPath === cachePath) return getActivePricingCache();
  bootPricingPath = cachePath;
  applyPricingCacheMetadata(cached);
  return cached;
}

export function schedulePricingMetadataRefresh(
  options: PricingFetcherOptions = {},
): void {
  if (refreshScheduled) return;
  refreshScheduled = true;
  void loadPricing(options).then((cache) => {
    if (cache !== null) applyPricingCacheMetadata(cache);
  });
}

export async function bootstrapPricingMetadata(
  options: PricingFetcherOptions = {},
): Promise<void> {
  await seedPricingMetadataFromCache(options);
  schedulePricingMetadataRefresh(options);
}

/** How many times the boot helper has called the pricing-cache reader. */
export function pricingCacheReadCountForTests(): number {
  return pricingCacheReadCount;
}

/** Test-only: reset the one-shot refresh guard and the boot read memo. */
export function resetPricingMetadataRefreshForTests(): void {
  refreshScheduled = false;
  bootPricingPath = undefined;
  bootPricingReads.clear();
  completedPricingReads.clear();
  pricingCacheReadCount = 0;
}
