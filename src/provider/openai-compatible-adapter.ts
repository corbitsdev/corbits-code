import {
  createOpenAIAdapter,
  registerProvider,
  type BuiltRequest,
  type ProviderAdapter,
} from "@intx/inference";

// The stock OpenAI adapter builds the request body from a fixed set of fields
// (max_tokens, temperature, tools, messages, response_format) and ignores
// `options.providerOptions` — so provider-native knobs carried there, such as
// OpenAI's `reasoning_effort`, never reach the wire. The Google adapter merges
// providerOptions into its body; the OpenAI one does not.
//
// Rather than fork the ~700-line adapter or patch the interchange submodule,
// this wraps the real adapter and post-processes only the request body: it
// delegates streaming, retry, and pacing untouched, and shallow-merges
// providerOptions into the already-built body (the same contract the Google
// adapter honors). Registering it under "openai-compatible" replaces the stock
// adapter for every source intercode builds.
type AdapterSource = Parameters<typeof createOpenAIAdapter>[0];

export function createOpenAICompatibleAdapter(source: AdapterSource): ProviderAdapter {
  const base = createOpenAIAdapter(source);
  const buildRequest: ProviderAdapter["buildRequest"] = (messages, model, options) => {
    const built = base.buildRequest(messages, model, options);
    const providerOptions = options.providerOptions;
    if (providerOptions === undefined || Object.keys(providerOptions).length === 0) {
      return built;
    }
    const body = JSON.parse(built.body) as Record<string, unknown>;
    Object.assign(body, providerOptions);
    const merged: BuiltRequest = { ...built, body: JSON.stringify(body) };
    return merged;
  };
  return { ...base, buildRequest };
}

// Override the stock "openai-compatible" provider with the wrapper. Idempotent:
// registerProvider is a map set, so calling this from every entry point is safe.
export function registerOpenAICompatibleAdapter(): void {
  registerProvider("openai-compatible", createOpenAICompatibleAdapter);
}
