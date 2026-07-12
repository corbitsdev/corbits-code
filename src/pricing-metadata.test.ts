import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getActivePricingCache } from "./cost/cost-visibility.js";
import {
  applyPricingCacheMetadata,
  resetPricingMetadataRefreshForTests,
  schedulePricingMetadataRefresh,
  seedPricingMetadataFromCache,
} from "./cost/pricing-metadata.js";
import { modelReasoningCapability } from "./provider/reasoning-effort.js";
import { contextWindowFor } from "./provider/context-window.js";
import { writePricingCache } from "./cost/pricing-fetcher.js";

describe("pricing-metadata", () => {
  afterEach(() => {
    resetPricingMetadataRefreshForTests();
    applyPricingCacheMetadata(null);
  });

  test("applyPricingCacheMetadata wires reasoning, context windows, and active cache", () => {
    applyPricingCacheMetadata({
      timestamp: 1,
      models: {},
      reasoning: { "gpt-test": true },
      contextWindows: { "gpt-test": 200_000 },
    });
    expect(modelReasoningCapability("gpt-test")).toBe(true);
    expect(contextWindowFor("gpt-test")).toBe(200_000);
    expect(getActivePricingCache()?.reasoning?.["gpt-test"]).toBe(true);
  });

  test("seedPricingMetadataFromCache reads project cache path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ic-pricing-meta-"));
    try {
      const cachePath = join(dir, "cache.json");
      await writePricingCache(
        {
          timestamp: 2,
          models: {
            m: { inputPricePerToken: 1, outputPricePerToken: 2, cacheReadPricePerToken: 0 },
          },
          reasoning: { m: false },
          contextWindows: { m: 32_000 },
        },
        cachePath,
      );
      await seedPricingMetadataFromCache({ cachePath });
      expect(modelReasoningCapability("m")).toBe(false);
      expect(contextWindowFor("m")).toBe(32_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("schedulePricingMetadataRefresh runs at most once", async () => {
    let calls = 0;
    const offlineFetch: typeof fetch = Object.assign(
      async () => {
        calls += 1;
        throw new Error("offline");
      },
      { preconnect: fetch.preconnect },
    );
    schedulePricingMetadataRefresh({ fetchImpl: offlineFetch });
    schedulePricingMetadataRefresh({ fetchImpl: offlineFetch });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(1);
  });
});