import {
  OPENCODE_GO_BASE_URL,
  OPENCODE_GO_MODEL_IDS,
} from "../../packages/opencode-go/src/index.js";
import {
  ZEN_DEFAULT_BASE_URL,
  ZEN_MODEL_IDS,
} from "../../packages/zen/src/index.js";
import { createBoundedModelCatalog } from "./bounded-model-catalog.js";

// Bound live /models so a huge or hostile catalog cannot blow process memory.
export const MAX_GO_CATALOG_BYTES = 256 * 1024;
export const MAX_GO_CATALOG_MODELS = 1024;
export const MAX_ZEN_CATALOG_BYTES = 256 * 1024;
export const MAX_ZEN_CATALOG_MODELS = 1024;

const goCatalog = createBoundedModelCatalog({
  baseURL: OPENCODE_GO_BASE_URL,
  seedIds: OPENCODE_GO_MODEL_IDS,
  catalogLabel: "OpenCode Go",
  maxBytes: MAX_GO_CATALOG_BYTES,
  maxModels: MAX_GO_CATALOG_MODELS,
});

const zenCatalog = createBoundedModelCatalog({
  baseURL: ZEN_DEFAULT_BASE_URL,
  seedIds: ZEN_MODEL_IDS,
  catalogLabel: "OpenCode Zen",
  maxBytes: MAX_ZEN_CATALOG_BYTES,
  maxModels: MAX_ZEN_CATALOG_MODELS,
});

/** Discover public OpenCode Go models without leaking transport or parsing failures. */
export const discoverGoModels = goCatalog.discoverModels;

/** Sync picker ids: last successful live list, else the packaged seed. Never empty. */
export const selectableGoModelIds = goCatalog.selectableModelIds;

/** Join or start a live fetch; the snapshot is the cache, inflight is only a mutex. */
export const prefetchGoModels = goCatalog.prefetchModels;

export const resetGoModelDiscoveryForTests = goCatalog.resetDiscoveryForTests;

/** Discover public OpenCode Zen models without leaking transport or parsing failures. */
export const discoverZenModels = zenCatalog.discoverModels;

/** Sync picker ids: last successful live list, else the packaged seed. Never empty. */
export const selectableZenModelIds = zenCatalog.selectableModelIds;

/** Join or start a live fetch; the snapshot is the cache, inflight is only a mutex. */
export const prefetchZenModels = zenCatalog.prefetchModels;

export const resetZenModelDiscoveryForTests = zenCatalog.resetDiscoveryForTests;
