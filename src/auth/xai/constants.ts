import { callbackTargetFor } from "@corbits/oauth-core";
import {
  XAI_DEFAULT_MODELS as VENDOR_XAI_DEFAULT_MODELS,
  XAI_OAUTH_PROXY_BASE_URL as XAI_BASE_URL,
  XAI_REDIRECT_URI,
  XAI_REFRESH_SKEW_MS,
  xaiOAuthConfig,
} from "@corbits/xai-provider";

export { XAI_BASE_URL, XAI_REDIRECT_URI, XAI_REFRESH_SKEW_MS };

const GROK_47 = "grok-4.7";

// Local extension over the vendor fallback list: grok-4.7 rides the
// same OAuth proxy as the older Grok generations but the vendored catalog has
// not caught up yet. Insert after the second vendor entry and skip when the
// vendor list already includes it so a vendor bump cannot duplicate. The
// default stays the first vendor entry.
export function extendVendorXaiDefaultModels(
  vendorModels: readonly string[],
): readonly [string, ...string[]] {
  if (vendorModels.some((id) => id === GROK_47)) {
    const [first, ...rest] = vendorModels;
    if (first === undefined) return [GROK_47];
    return [first, ...rest];
  }
  const [first, second, ...rest] = vendorModels;
  if (first === undefined) return [GROK_47];
  if (second === undefined) return [first, GROK_47];
  return [first, second, GROK_47, ...rest];
}

export const XAI_DEFAULT_MODELS = extendVendorXaiDefaultModels(
  VENDOR_XAI_DEFAULT_MODELS,
);

const callbackTarget = callbackTargetFor(xaiOAuthConfig);
export const XAI_CALLBACK_HOST = callbackTarget.host;
export const XAI_CALLBACK_PORT = callbackTarget.port;
export const XAI_CALLBACK_PATH = callbackTarget.path;

// Cap every token request to the xAI proxy. The refresh runs on the
// send path before the inference fetch arms its inactivity/total timers, so a
// stalled token endpoint would otherwise freeze the agent at turn 0.
export const XAI_TOKEN_TIMEOUT_MS = 15_000;
