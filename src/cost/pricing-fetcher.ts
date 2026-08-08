import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { type } from "arktype";
import { SETTINGS_DIR_NAME } from "../branding.js";

export type ModelPricing = {
  inputPricePerToken: number;
  outputPricePerToken: number;
  cacheReadPricePerToken: number;
};

export type PricingCache = {
  timestamp: number;
  models: Record<string, ModelPricing>;
  // models.dev also publishes a per-model `reasoning` boolean. Captured here so
  // the /agent reasoning-effort selector can hide options for non-reasoning
  // models. Optional for backward compatibility with caches written before it.
  reasoning?: Record<string, boolean>;
  // models.dev publishes a per-model `limit.context` token count. Captured so
  // compaction can target a fraction of the real window instead of a fixed
  // constant. Optional for backward compatibility with older caches.
  contextWindows?: Record<string, number>;
};

export type PricingFetcherOptions = {
  cachePath?: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  fetchTimeoutMs?: number;
  now?: () => number;
  refreshIntervalMs?: number;
};

/** Default models-pricing cache under the tool home dir (not project cwd). */
export function defaultPricingCachePath(home: string = homedir()): string {
  return join(home, SETTINGS_DIR_NAME, "cache", "models-pricing.json");
}

const DEFAULT_ENDPOINT = "https://models.dev/api.json";
const DEFAULT_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 5000;

const modelPricingValidator = type({
  inputPricePerToken: "number",
  outputPricePerToken: "number",
  cacheReadPricePerToken: "number",
});

const pricingCacheHeaderValidator = type({
  timestamp: "number",
  models: "object",
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getNumberField(value: Record<string, unknown>, field: string): number | null {
  const raw = value[field];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function parseModelPricing(value: unknown): ModelPricing | null {
  if (!isRecord(value)) return null;
  const input = getNumberField(value, "input_cost_per_million");
  const output = getNumberField(value, "output_cost_per_million");
  const cacheRead = getNumberField(value, "cache_read_cost_per_million") ?? 0;
  if (input === null || output === null) return null;
  return {
    inputPricePerToken: input / 1_000_000,
    outputPricePerToken: output / 1_000_000,
    cacheReadPricePerToken: cacheRead / 1_000_000,
  };
}

/**
 * Recurses through an untyped models.dev JSON tree and yields every node that
 * resolves to a model id, alongside that node. Each `parseModelsDev*` walker
 * below shares this single traversal and only differs in which field it
 * extracts from the yielded node.
 */
function* walkModelNodes(value: unknown): Generator<[id: string, node: Record<string, unknown>]> {
  if (Array.isArray(value)) {
    for (const item of value) yield* walkModelNodes(item);
    return;
  }
  if (!isRecord(value)) return;

  const id = typeof value.id === "string" ? value.id : typeof value.model === "string" ? value.model : null;
  if (id !== null) yield [id, value];

  for (const child of Object.values(value)) {
    yield* walkModelNodes(child);
  }
}

export function parseModelsDevPricing(payload: unknown): Record<string, ModelPricing> {
  const models: Record<string, ModelPricing> = {};
  for (const [id, node] of walkModelNodes(payload)) {
    const pricing = parseModelPricing(node);
    if (pricing !== null) models[id] = pricing;
  }
  return models;
}

export function parseModelsDevReasoning(payload: unknown): Record<string, boolean> {
  const reasoning: Record<string, boolean> = {};
  for (const [id, node] of walkModelNodes(payload)) {
    if (typeof node.reasoning === "boolean") reasoning[id] = node.reasoning;
  }
  return reasoning;
}

export function parseModelsDevContextWindows(payload: unknown): Record<string, number> {
  const windows: Record<string, number> = {};
  for (const [id, node] of walkModelNodes(payload)) {
    // models.dev nests the window under `limit.context`.
    const limit = isRecord(node.limit) ? node.limit : undefined;
    const context = limit !== undefined && typeof limit.context === "number" ? limit.context : undefined;
    if (context !== undefined && Number.isFinite(context) && context > 0) {
      windows[id] = context;
    }
  }
  return windows;
}

export async function readPricingCache(cachePath = defaultPricingCachePath()): Promise<PricingCache | null> {
  try {
    const payload = JSON.parse(await Bun.file(cachePath).text());
    const parsed = pricingCacheHeaderValidator(payload);
    if (parsed instanceof type.errors) return null;
    const models: Record<string, ModelPricing> = {};
    for (const [modelId, modelPricing] of Object.entries(parsed.models)) {
      const pricing = modelPricingValidator(modelPricing);
      if (pricing instanceof type.errors) return null;
      models[modelId] = pricing;
    }
    const reasoning: Record<string, boolean> = {};
    if (isRecord(payload) && isRecord(payload.reasoning)) {
      for (const [modelId, flag] of Object.entries(payload.reasoning)) {
        if (typeof flag === "boolean") reasoning[modelId] = flag;
      }
    }
    const contextWindows: Record<string, number> = {};
    if (isRecord(payload) && isRecord(payload.contextWindows)) {
      for (const [modelId, window] of Object.entries(payload.contextWindows)) {
        if (typeof window === "number" && Number.isFinite(window) && window > 0) {
          contextWindows[modelId] = window;
        }
      }
    }
    return {
      timestamp: parsed.timestamp,
      models,
      ...(Object.keys(reasoning).length > 0 ? { reasoning } : {}),
      ...(Object.keys(contextWindows).length > 0 ? { contextWindows } : {}),
    };
  } catch {
    return null;
  }
}

export async function writePricingCache(cache: PricingCache, cachePath = defaultPricingCachePath()): Promise<void> {
  try {
    await mkdir(dirname(cachePath), { recursive: true });
    await Bun.write(cachePath, `${JSON.stringify(cache, null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`pricing-fetcher: failed to write cache: ${err}\n`);
  }
}

export async function fetchPricing(options: PricingFetcherOptions = {}): Promise<PricingCache> {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const response = await fetchImpl(endpoint, { signal: AbortSignal.timeout(options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`models.dev pricing request failed: ${response.status}`);
  }
  const payload = await response.json();
  const models = parseModelsDevPricing(payload);
  if (Object.keys(models).length === 0) {
    throw new Error("models.dev pricing response did not include model prices");
  }
  const reasoning = parseModelsDevReasoning(payload);
  const contextWindows = parseModelsDevContextWindows(payload);
  return {
    timestamp: now(),
    models,
    ...(Object.keys(reasoning).length > 0 ? { reasoning } : {}),
    ...(Object.keys(contextWindows).length > 0 ? { contextWindows } : {}),
  };
}

export async function loadPricing(options: PricingFetcherOptions = {}): Promise<PricingCache | null> {
  const cachePath = options.cachePath ?? defaultPricingCachePath();
  try {
    const pricing = await fetchPricing(options);
    await writePricingCache(pricing, cachePath);
    return pricing;
  } catch {
    return readPricingCache(cachePath);
  }
}

export function lookupModelPricing(cache: PricingCache | null, modelId: string): ModelPricing | null {
  return cache?.models[modelId] ?? null;
}

export function startPricingRefresh(options: PricingFetcherOptions = {}): Timer {
  const refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
  const timer = setInterval(() => {
    loadPricing(options).catch((err: unknown) => {
      process.stderr.write(`pricing-fetcher: refresh error: ${err}\n`);
    });
  }, refreshIntervalMs);
  return timer;
}
