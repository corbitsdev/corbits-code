import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { expect, test } from "bun:test";

import { fetchPricing, loadPricing, parseModelsDevPricing, parseModelsDevContextWindows, readPricingCache, writePricingCache } from "../../src/cost/pricing-fetcher.js";

test("parseModelsDevContextWindows reads limit.context per model", () => {
  const windows = parseModelsDevContextWindows({
    "z-ai": {
      models: {
        "glm-4.6": { id: "z-ai/glm-4.6", limit: { context: 64_000, output: 8_000 } },
      },
    },
    openai: {
      models: {
        "gpt-4.1": { id: "openai/gpt-4.1", limit: { context: 1_000_000 } },
        "no-limit": { id: "openai/no-limit" },
      },
    },
  });
  expect(windows["z-ai/glm-4.6"]).toBe(64_000);
  expect(windows["openai/gpt-4.1"]).toBe(1_000_000);
  expect(windows["openai/no-limit"]).toBeUndefined();
});

test("parseModelsDevPricing walks a top-level array payload the same way the other collectors do", () => {
  // A nesting level where the root itself is an array, rather than an object
  // whose values are arrays. parseModelsDevReasoning and
  // parseModelsDevContextWindows already handle this; pricing must match.
  const models = parseModelsDevPricing([
    { id: "m1", input_cost_per_million: 1, output_cost_per_million: 2 },
  ]);
  expect(models["m1"]).toBeDefined();
});

function response(body: unknown, ok = true, status = 200): Response {
  return new Response(JSON.stringify(body), { status: ok ? status : status });
}

test("parseModelsDevPricing supports multiple model IDs", () => {
  const models = parseModelsDevPricing({
    openai: {
      models: {
        "gpt-4.1": {
          id: "openai/gpt-4.1",
          input_cost_per_million: 2,
          output_cost_per_million: 8,
          cache_read_cost_per_million: 0.5,
        },
      },
    },
    anthropic: {
      models: [
        {
          id: "anthropic/claude-sonnet-4",
          input_cost_per_million: 3,
          output_cost_per_million: 15,
        },
      ],
    },
  });

  expect(models["openai/gpt-4.1"]).toEqual({
    inputPricePerToken: 0.000002,
    outputPricePerToken: 0.000008,
    cacheReadPricePerToken: 0.0000005,
  });
  expect(models["anthropic/claude-sonnet-4"]).toEqual({
    inputPricePerToken: 0.000003,
    outputPricePerToken: 0.000015,
    cacheReadPricePerToken: 0,
  });
});

test("fetchPricing fetches and timestamps model prices", async () => {
  const pricing = await fetchPricing({
    endpoint: "https://example.test/models.json",
    now: () => 123,
    fetchImpl: async () => response({
      models: [{
        id: "provider/model",
        input_cost_per_million: 1,
        output_cost_per_million: 2,
        cache_read_cost_per_million: 0.25,
      }],
    }),
  });

  expect(pricing).toEqual({
    timestamp: 123,
    models: {
      "provider/model": {
        inputPricePerToken: 0.000001,
        outputPricePerToken: 0.000002,
        cacheReadPricePerToken: 0.00000025,
      },
    },
  });
});

test("loadPricing writes fetched prices to cache", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pricing-cache-"));
  const cachePath = join(dir, "models-pricing.json");
  try {
    await loadPricing({
      cachePath,
      now: () => 456,
      fetchImpl: async () => response({
        models: [{ id: "provider/model", input_cost_per_million: 10, output_cost_per_million: 20 }],
      }),
    });

    expect(await readPricingCache(cachePath)).toEqual({
      timestamp: 456,
      models: {
        "provider/model": {
          inputPricePerToken: 0.00001,
          outputPricePerToken: 0.00002,
          cacheReadPricePerToken: 0,
        },
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadPricing falls back to cache when API is unavailable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pricing-cache-"));
  const cachePath = join(dir, "models-pricing.json");
  const cached = {
    timestamp: 789,
    models: {
      "cached/model": {
        inputPricePerToken: 0.1,
        outputPricePerToken: 0.2,
        cacheReadPricePerToken: 0.03,
      },
    },
  };
  try {
    await writePricingCache(cached, cachePath);

    const pricing = await loadPricing({
      cachePath,
      fetchImpl: async () => { throw new Error("offline"); },
    });

    expect(pricing).toEqual(cached);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
