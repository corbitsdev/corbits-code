import { CODEX_BASE_URL } from "../auth/codex/constants.js";
import { isCodexProviderName } from "../config/codex-providers.js";
import { lookupModelPricing, type PricingCache } from "./pricing-fetcher.js";

// Free-model naming conventions: OpenRouter appends ":free", some gateways use
// a "-free" suffix. Either, at the end of the id, marks a no-cost model.
const FREE_MODEL_SUFFIX = /[:-]free$/i;

export function isFreeModelId(modelId: string): boolean {
  return FREE_MODEL_SUFFIX.test(modelId.trim());
}

// A coding plan is a prepaid subscription rather than metered API usage. Such
// endpoints carry a "coding" path segment in the base URL (e.g. Z.AI's coding
// plan at /api/coding/...), so per-token dollar figures are meaningless and
// should be hidden. Matched as a whole path segment so "/encoding" or a
// "?x=/coding" query string never trips it.
const CODING_PLAN_SEGMENT = /\/coding(\/|$)/i;

export function isCodingPlanBaseURL(baseURL: string | undefined): boolean {
  if (baseURL === undefined) return false;
  try {
    return CODING_PLAN_SEGMENT.test(new URL(baseURL).pathname);
  } catch {
    return CODING_PLAN_SEGMENT.test(baseURL);
  }
}

// First-class Z.AI Coding Plan catalog id. Live /model identity uses this
// name, not the launch baseURL, so a switch onto or off zai updates $ now.
export function isCodingPlanProviderName(name: string): boolean {
  return name === "zai";
}

// Codex OAuth bills against the user's ChatGPT subscription via
// chatgpt.com/backend-api. Public per-token rates for the same model ids do
// not apply there, so dollar estimates must be suppressed. Matched against
// the canonical Codex base (origin + path prefix) so api.openai.com stays
// metered and a bare chatgpt.com host does not hide costs.
const CODEX_BASE = new URL(CODEX_BASE_URL);
const CODEX_ORIGIN = CODEX_BASE.origin;
const CODEX_PATH = CODEX_BASE.pathname.replace(/\/$/, "").toLowerCase();
// Host-anchored: a scheme or start of string must precede chatgpt.com so
// notchatgpt.com/backend-api never matches. Query/hash after the path still
// count. Unparseable noise that merely contains the substring does not.
const CHATGPT_SUBSCRIPTION_FALLBACK = /(?:^|\/\/)chatgpt\.com\/backend-api(?:\/|$|\?|#)/i;

export function isChatGPTSubscriptionBaseURL(baseURL: string | undefined): boolean {
  if (baseURL === undefined) return false;
  try {
    const url = new URL(baseURL);
    if (url.origin !== CODEX_ORIGIN) return false;
    const path = url.pathname.replace(/\/$/, "").toLowerCase() || "/";
    return path === CODEX_PATH || path.startsWith(`${CODEX_PATH}/`);
  } catch {
    return CHATGPT_SUBSCRIPTION_FALLBACK.test(baseURL);
  }
}

export function isFreeModelByPricing(cache: PricingCache | null, modelId: string): boolean {
  const pricing = lookupModelPricing(cache, modelId);
  if (pricing === null) return false;
  return pricing.inputPricePerToken === 0 && pricing.outputPricePerToken === 0;
}

export interface CostVisibilityInput {
  baseURL?: string | undefined;
  // Live /model identity. When set, it wins over a stale launch baseURL for
  // ChatGPT-subscription and coding-plan hides: Codex names hide even on
  // api.openai.com, zai names hide even on a metered URL; a present
  // non-matching name shows even when launch URL would hide. Undefined
  // falls back to URL.
  providerName?: string | undefined;
  modelId: string;
  providerFree?: boolean | undefined;
  pricingCache: PricingCache | null;
}

export type CostHiddenReason =
  "provider-free" | "coding-plan" | "chatgpt-subscription" | "free-model" | "zero-priced";

function isCodingPlanSession(input: CostVisibilityInput): boolean {
  if (input.providerName !== undefined) {
    return isCodingPlanProviderName(input.providerName);
  }
  return isCodingPlanBaseURL(input.baseURL);
}

function isChatGPTSubscriptionSession(input: CostVisibilityInput): boolean {
  if (input.providerName !== undefined) {
    return isCodexProviderName(input.providerName);
  }
  return isChatGPTSubscriptionBaseURL(input.baseURL);
}

// Non-null when the dollar cost should be suppressed: a manual provider
// override, a coding-plan session (live zai identity, else /coding URL), a
// ChatGPT/Codex subscription (live provider identity, else Codex URL), a
// free-named model, or a model the pricing registry reports as zero-cost.
// The reason is carried to the display so /cost can say which condition hid
// the figure.
export function costHiddenReason(input: CostVisibilityInput): CostHiddenReason | null {
  if (input.providerFree === true) return "provider-free";
  if (isCodingPlanSession(input)) return "coding-plan";
  if (isChatGPTSubscriptionSession(input)) return "chatgpt-subscription";
  if (isFreeModelId(input.modelId)) return "free-model";
  return isFreeModelByPricing(input.pricingCache, input.modelId) ? "zero-priced" : null;
}

// The pricing cache loaded at startup. Held as a module global so the render
// path can consult it without an effect (it is effectively static after load),
// mirroring the reasoning-capabilities registry.
let activePricingCache: PricingCache | null = null;

export function setActivePricingCache(cache: PricingCache | null): void {
  activePricingCache = cache;
}

export function getActivePricingCache(): PricingCache | null {
  return activePricingCache;
}
