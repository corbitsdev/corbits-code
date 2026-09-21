import { XAI_REDIRECT_URI } from "@corbits/xai-provider";

import {
  XAI_DEFAULT_MODELS as VENDOR_XAI_DEFAULT_MODELS,
  XAI_OAUTH_PROXY_BASE_URL as XAI_BASE_URL,
  XAI_REFRESH_SKEW_MS,
} from "@corbits/xai-provider";

export { XAI_BASE_URL, XAI_REDIRECT_URI, XAI_REFRESH_SKEW_MS };

const GROK_47 = "grok-4.7";

// Local extension over the vendor fallback list (CL-5691): grok-4.7 rides the
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

const xaiRedirect = new URL(XAI_REDIRECT_URI);
export const XAI_CALLBACK_PORT = Number(xaiRedirect.port);
export const XAI_CALLBACK_PATH = xaiRedirect.pathname;

// The CLI chat proxy speaks the OpenAI Responses API and authenticates the
// caller by client headers in addition to the bearer token. Values mirror the
// grok CLI's own request (captured live). Do not replace these with a product
// user-agent — the proxy and billing surfaces expect the grok-shell identity.
export const XAI_CLIENT_IDENTIFIER = "grok-shell";
export const XAI_CLIENT_VERSION = "0.2.93";
export const XAI_USER_AGENT = "grok-shell/0.2.93 (macos; aarch64)";

// Cap every token request to the xAI proxy. The refresh runs on the
// send path before the inference fetch arms its inactivity/total timers, so a
// stalled token endpoint would otherwise freeze the agent at turn 0.
export const XAI_TOKEN_TIMEOUT_MS = 15_000;
