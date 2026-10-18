import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { callbackTargetFor } from "@corbits/oauth-core";

const require = createRequire(import.meta.url);
const packageIndex = pathToFileURL(require.resolve("@corbits/xai-provider"));
const {
  XAI_DEFAULT_MODELS: VENDOR_XAI_DEFAULT_MODELS,
  XAI_OAUTH_PROXY_BASE_URL: XAI_BASE_URL,
} = require(fileURLToPath(new URL("./constants.js", packageIndex))) as {
  XAI_DEFAULT_MODELS: readonly string[];
  XAI_OAUTH_PROXY_BASE_URL: string;
};
const { xaiOAuthConfig } = require(
  fileURLToPath(new URL("./oauth.js", packageIndex)),
) as {
  xaiOAuthConfig: Parameters<typeof callbackTargetFor>[0];
};

export { XAI_BASE_URL };

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
