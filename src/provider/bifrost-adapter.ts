import {
  BEARER_CREDENTIAL_SENTINEL,
  CREDENTIAL_SENTINEL,
  type BuiltRequest,
  type ProviderAdapter,
} from "@intx/inference";
import { createOpenAIAdapter } from "@intx/inference/providers";

// Small adapter for Bifrost (https://docs.getbifrost.ai).
// Bifrost is OpenAI-compatible for chat but uses a virtual-key header
// `x-bf-vk` (raw key value) in addition to Authorization: Bearer to scope
// requests to a particular virtual key's permissions and model list.
//
// We flag providers with `bifrostVirtualKey: true` so:
// - buildInferenceSourceForRef emits provider: "bifrost"
// - this adapter is selected
// - we inject the x-bf-vk sentinel (and keep the bearer one)
//
// Model listing for such providers can be done via fetchBifrostModels which
// calls the gateway's /models with the same headers.

export const BIFROST_PROVIDER = "bifrost";

type AdapterSource = Parameters<typeof createOpenAIAdapter>[0];

export function createBifrostAdapter(source: AdapterSource): ProviderAdapter {
  const base = createOpenAIAdapter(source);

  const buildRequest: ProviderAdapter["buildRequest"] = (messages, model, options) => {
    const req = base.buildRequest(messages, model, options);
    return {
      ...req,
      headers: {
        ...req.headers,
        "x-bf-vk": CREDENTIAL_SENTINEL,
        // The base adapter will have already emitted authorization as the
        // BEARER sentinel; we ensure it is present (spread keeps it) and also
        // tolerate gateways that only look at x-bf-vk.
      },
    } as BuiltRequest;
  };

  return {
    ...base,
    buildRequest,
  };
}
