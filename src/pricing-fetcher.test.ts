import { defined } from "./testkit/defined.js";
import { describe, test, expect } from "bun:test";
import { isAbsolute, join } from "node:path";
import {
  parseModelsDevContextWindows,
  parseModelsDevPricing,
  parseModelsDevReasoning,
  fetchPricing,
  loadPricing,
  lookupModelPricing,
  readPricingCache,
  writePricingCache,
  startPricingRefresh,
  defaultPricingCachePath,
  type PricingCache,
} from "./cost/pricing-fetcher.js";
import { testPricingCache } from "./cost/pricing-test-fixture.js";

// ---------------------------------------------------------------------------
// defaultPricingCachePath
// ---------------------------------------------------------------------------

describe("defaultPricingCachePath", () => {
  test("resolves under ~/.corbits/, not project cwd .cache/", () => {
    const path = defaultPricingCachePath();
    expect(isAbsolute(path)).toBe(true);
    // Must not be the old cwd-relative default that polluted project directories.
    expect(path).not.toBe(".cache/models-pricing.json");
    expect(path.endsWith(join(".cache", "models-pricing.json"))).toBe(false);
  });
});

describe("parseModelsDevReasoning", () => {
  test("collects the per-model reasoning flag from a nested models.dev payload", () => {
    const payload = {
      openai: {
        models: {
          "gpt-5.1": { id: "gpt-5.1", reasoning: true },
          "gpt-4o": { id: "gpt-4o", reasoning: false },
          legacy: { id: "legacy" },
        },
      },
    };
    expect(parseModelsDevReasoning(payload)).toEqual({
      "gpt-5.1": true,
      "gpt-4o": false,
    });
  });
});

// ---------------------------------------------------------------------------
// parseModelsDevPricing
// ---------------------------------------------------------------------------

/** Flat models.dev entry with default per-million costs; overrides win. */
function pricingPayload(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return {
    input_cost_per_million: 10,
    output_cost_per_million: 20,
    ...fields,
  };
}

describe("parseModelsDevPricing", () => {
  for (const { name, payload, modelId, expected } of [
    {
      name: "extracts model pricing from a flat object with id field",
      payload: pricingPayload({
        id: "gpt-4",
        input_cost_per_million: 30,
        output_cost_per_million: 60,
        cache_read_cost_per_million: 3,
      }),
      modelId: "gpt-4",
      expected: {
        inputPricePerToken: 30 / 1_000_000,
        outputPricePerToken: 60 / 1_000_000,
        cacheReadPricePerToken: 3 / 1_000_000,
      },
    },
    {
      name: "extracts model pricing using model field when id is absent",
      payload: pricingPayload({
        model: "claude-3",
        input_cost_per_million: 15,
        output_cost_per_million: 75,
      }),
      modelId: "claude-3",
      expected: {
        inputPricePerToken: 15 / 1_000_000,
        outputPricePerToken: 75 / 1_000_000,
        cacheReadPricePerToken: 0,
      },
    },
    {
      name: "defaults cacheReadPricePerToken to 0 when field is absent",
      payload: pricingPayload({ id: "model-x" }),
      modelId: "model-x",
      expected: {
        inputPricePerToken: 10 / 1_000_000,
        outputPricePerToken: 20 / 1_000_000,
        cacheReadPricePerToken: 0,
      },
    },
  ]) {
    test(name, () => {
      expect(parseModelsDevPricing(payload)[modelId]).toEqual(expected);
    });
  }

  test("recurses into nested objects", () => {
    const payload = {
      providers: {
        anthropic: {
          models: [
            {
              id: "claude-opus",
              input_cost_per_million: 15,
              output_cost_per_million: 75,
            },
          ],
        },
      },
    };
    const result = parseModelsDevPricing(payload);
    expect(result["claude-opus"]).toBeDefined();
  });

  test("recurses into arrays nested under an object", () => {
    const payload = {
      models: [
        { id: "m1", input_cost_per_million: 1, output_cost_per_million: 2 },
        { id: "m2", input_cost_per_million: 3, output_cost_per_million: 6 },
      ],
    };
    const result = parseModelsDevPricing(payload);
    expect(result["m1"]).toBeDefined();
    expect(result["m2"]).toBeDefined();
  });

  test("skips entries missing input or output cost", () => {
    const payload = {
      id: "incomplete",
      output_cost_per_million: 20,
      // missing input_cost_per_million
    };
    const result = parseModelsDevPricing(payload);
    expect(result["incomplete"]).toBeUndefined();
  });

  test("returns empty object for input with no model entries", () => {
    expect(parseModelsDevPricing(null)).toEqual({});
    expect(parseModelsDevPricing("string")).toEqual({});
    expect(parseModelsDevPricing(42)).toEqual({});
    expect(parseModelsDevPricing({})).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// lookupModelPricing
// ---------------------------------------------------------------------------

describe("lookupModelPricing", () => {
  // Shared cost fixture (covers gpt-4 at the same prices).
  const cache: PricingCache = testPricingCache;

  test("returns pricing for a known model", () => {
    expect(lookupModelPricing(cache, "gpt-4")).toEqual(
      defined(cache.models["gpt-4"]),
    );
  });

  test("returns null for an unknown model", () => {
    expect(lookupModelPricing(cache, "unknown-model")).toBeNull();
  });

  test("returns null when cache is null", () => {
    expect(lookupModelPricing(null, "gpt-4")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fetchPricing
// ---------------------------------------------------------------------------

describe("fetchPricing", () => {
  test("parses a successful response and returns a cache object", async () => {
    const mockPayload = {
      models: [
        {
          id: "test-model",
          input_cost_per_million: 10,
          output_cost_per_million: 20,
        },
      ],
    };
    const mockFetch = async () => ({ ok: true, json: async () => mockPayload });

    const fixedNow = 1_700_000_000_000;
    const result = await fetchPricing({
      fetchImpl: mockFetch as unknown as typeof fetch,
      now: () => fixedNow,
    });

    expect(result.timestamp).toBe(fixedNow);
    expect(result.models["test-model"]).toBeDefined();
  });

  test("throws when response is not ok", async () => {
    const mockFetch = async () => ({ ok: false, status: 503 });
    await expect(
      fetchPricing({ fetchImpl: mockFetch as unknown as typeof fetch }),
    ).rejects.toThrow("503");
  });

  test("throws when response contains no model prices", async () => {
    const mockFetch = async () => ({ ok: true, json: async () => ({}) });
    await expect(
      fetchPricing({ fetchImpl: mockFetch as unknown as typeof fetch }),
    ).rejects.toThrow("did not include model prices");
  });
});

// ---------------------------------------------------------------------------
// loadPricing
// ---------------------------------------------------------------------------

describe("loadPricing", () => {
  test("returns fetch result and writes cache on success", async () => {
    const mockPayload = {
      models: [
        { id: "m1", input_cost_per_million: 5, output_cost_per_million: 10 },
      ],
    };
    const mockFetch = async () => ({ ok: true, json: async () => mockPayload });

    const result = await loadPricing({
      fetchImpl: mockFetch as unknown as typeof fetch,
      now: () => 0,
      cachePath: `/tmp/test-pricing-cache-${Date.now()}.json`,
    });

    expect(result).not.toBeNull();
    expect(defined(result).models["m1"]).toBeDefined();
  });

  test("falls back to disk cache when fetch fails", async () => {
    const failingFetch = (async (): Promise<Response> => {
      throw new Error("network error");
    }) as unknown as typeof fetch;

    // Point at a non-existent cache path — should return null (no fallback available)
    const result = await loadPricing({
      fetchImpl: failingFetch,
      cachePath: "/tmp/nonexistent-pricing-cache-xyz.json",
    });

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// startPricingRefresh
// ---------------------------------------------------------------------------

describe("startPricingRefresh", () => {
  test("returns a timer and can be cleared without throwing", () => {
    const timer = startPricingRefresh({
      refreshIntervalMs: 999_999,
      fetchImpl: (async () =>
        ({ ok: false, status: 500 }) as Response) as unknown as typeof fetch,
      cachePath: "/tmp/nonexistent-refresh-cache.json",
    });
    expect(timer).toBeDefined();
    clearInterval(timer);
  });
});

// ---------------------------------------------------------------------------
// readPricingCache / writePricingCache round-trip
// ---------------------------------------------------------------------------

describe("readPricingCache / writePricingCache", () => {
  test("round-trips a valid cache object", async () => {
    const cache: PricingCache = {
      timestamp: 12345,
      models: {
        "test-model": {
          inputPricePerToken: 0.000001,
          outputPricePerToken: 0.000002,
          cacheReadPricePerToken: 0,
        },
      },
    };
    const path = `/tmp/pricing-test-roundtrip-${Date.now()}.json`;
    await writePricingCache(cache, path);
    const loaded = await readPricingCache(path);
    expect(loaded).toEqual(cache);
  });

  test("returns null for a path that does not exist", async () => {
    const result = await readPricingCache(
      "/tmp/nonexistent-pricing-abc123.json",
    );
    expect(result).toBeNull();
  });

  test("returns null when cache file has invalid structure", async () => {
    const path = `/tmp/pricing-test-invalid-${Date.now()}.json`;
    await Bun.write(path, JSON.stringify({ not: "a cache" }));
    const result = await readPricingCache(path);
    expect(result).toBeNull();
  });

  test("returns null when cache file has invalid model entry", async () => {
    const path = `/tmp/pricing-test-bad-model-${Date.now()}.json`;
    await Bun.write(
      path,
      JSON.stringify({
        timestamp: 1,
        models: { "bad-model": { inputPricePerToken: "not-a-number" } },
      }),
    );
    const result = await readPricingCache(path);
    expect(result).toBeNull();
  });
});

describe("parseModelsDevContextWindows", () => {
  test("reads limit.context per model", () => {
    const windows = parseModelsDevContextWindows({
      "z-ai": {
        models: {
          "glm-4.6": {
            id: "z-ai/glm-4.6",
            limit: { context: 64_000, output: 8_000 },
          },
        },
      },
      openai: {
        models: {
          "gpt-5.6": { id: "openai/gpt-5.6", limit: { context: 1_000_000 } },
          "no-limit": { id: "openai/no-limit" },
        },
      },
    });
    expect(windows["z-ai/glm-4.6"]).toBe(64_000);
    expect(windows["openai/gpt-5.6"]).toBe(1_000_000);
    expect(windows["openai/no-limit"]).toBeUndefined();
  });
});

describe("parseModelsDevPricing root array", () => {
  test("walks a top-level array payload the same way the other collectors do", () => {
    // A nesting level where the root itself is an array, rather than an object
    // whose values are arrays. parseModelsDevReasoning and
    // parseModelsDevContextWindows already handle this; pricing must match.
    const models = parseModelsDevPricing([
      { id: "m1", input_cost_per_million: 1, output_cost_per_million: 2 },
    ]);
    expect(models["m1"]).toBeDefined();
  });
});
