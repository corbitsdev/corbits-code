import { type BuiltRequest, type ProviderAdapter } from "@intx/inference";
import { createOpenAIAdapter } from "@intx/inference/providers";
import { normalizeNullDeltaFields } from "./sse-delta-patch.js";

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
// adapter for every source corbits builds.
type AdapterSource = Parameters<typeof createOpenAIAdapter>[0];

export function createOpenAICompatibleAdapter(
  source: AdapterSource,
  quirks?: unknown,
): ProviderAdapter {
  const base = createOpenAIAdapter(source, quirks);
  // Set by buildRequest for the model the current request targets; only
  // DeepSeek/NIM streams need the null-delta-field patch below, so every
  // other provider's frames skip the reparse and hit base.parseResponse
  // exactly once instead of twice.
  let needsDeepSeekPatch = false;

  const ensureAccept = (req: BuiltRequest): BuiltRequest => {
    const has = req.headers.Accept || req.headers.accept;
    if (has) return req;
    return {
      ...req,
      headers: { ...req.headers, Accept: "text/event-stream" },
    };
  };

  const buildRequest: ProviderAdapter["buildRequest"] = (messages, model, options) => {
    const built = base.buildRequest(messages, model, options);
    const providerOptions = options.providerOptions;
    const hasProviderOptions =
      providerOptions !== undefined && Object.keys(providerOptions).length > 0;
    // DeepSeek returns HTTP 400 if `reasoning_content` appears in input messages,
    // whereas the base adapter emits it for any model with thinking enabled.
    const stripReasoning = model.toLowerCase().includes("deepseek");
    needsDeepSeekPatch = stripReasoning;
    if (!hasProviderOptions && !stripReasoning) return ensureAccept(built);

    const body = JSON.parse(built.body) as Record<string, unknown>;
    if (hasProviderOptions) Object.assign(body, providerOptions);
    if (stripReasoning && Array.isArray(body["messages"])) {
      for (const msg of body["messages"]) {
        if (msg !== null && typeof msg === "object")
          delete (msg as Record<string, unknown>)["reasoning_content"];
      }
    }
    const merged: BuiltRequest = { ...built, body: JSON.stringify(body) };
    return ensureAccept(merged);
  };

  const parseResponse: ProviderAdapter["parseResponse"] = (sseData: string) => {
    if (!needsDeepSeekPatch) return base.parseResponse(sseData);
    return base.parseResponse(normalizeNullDeltaFields(sseData));
  };

  return { ...base, buildRequest, parseResponse };
}
