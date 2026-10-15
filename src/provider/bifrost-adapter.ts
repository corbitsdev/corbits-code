import { CREDENTIAL_SENTINEL, type ProviderAdapter } from "@intx/inference";
import { createOpenAICompatibleAdapter } from "./openai-compatible-adapter.js";
import { withExtraHeaders } from "./adapter-decorators.js";

// Small adapter for Bifrost (https://docs.getbifrost.ai). Bifrost is
// OpenAI-compatible for chat but scopes requests to a virtual key's
// permissions and model list via an `x-bf-vk` header (raw key value)
// alongside Authorization: Bearer. `bifrostVirtualKey: true` providers get
// this adapter, the x-bf-vk sentinel, and provider: "bifrost" from
// buildInferenceSourceForRef.

export const BIFROST_PROVIDER = "bifrost";

type AdapterSource = Parameters<typeof createOpenAICompatibleAdapter>[0];

// Wraps the patched openai-compatible adapter (not the stock one) so Bifrost
// requests inherit the Accept: text/event-stream header — Bifrost answers a
// streaming request without it with HTTP 426 — plus the providerOptions merge
// and delta patching every other OpenAI-shaped source gets.
export function createBifrostAdapter(source: AdapterSource): ProviderAdapter {
  return withExtraHeaders(createOpenAICompatibleAdapter(source), () => ({
    "x-bf-vk": CREDENTIAL_SENTINEL,
    // The base adapter has already emitted authorization as the BEARER
    // sentinel; the spread keeps it, and gateways that only look at x-bf-vk
    // are tolerated.
  }));
}
