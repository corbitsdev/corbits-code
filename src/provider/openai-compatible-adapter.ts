import { type BuiltRequest, type ProviderAdapter } from "@intx/inference";
import { createOpenAIAdapter } from "@intx/inference/providers";
import type { ReasoningEffort } from "../agent/profile-types.js";
import { isDeepSeekV4Model, mapV4Effort } from "./deepseek-v4-effort.js";
import { normalizeNullDeltaFields } from "./null-delta-fields.js";

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

  const buildRequest: ProviderAdapter["buildRequest"] = (
    messages,
    model,
    options,
  ) => {
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
    // V4's ladder (none/xhigh/max) is translated here: `none` drops
    // reasoning_effort and toggles the encoder's thinking off (it is illegal
    // on the wire), while `xhigh`/`max` go out raw. Effort absent under V4 is
    // left absent.
    if (isDeepSeekV4Model(model)) {
      if ("reasoning_effort" in body) {
        const raw = body["reasoning_effort"] as ReasoningEffort;
        const wire = mapV4Effort(raw);
        if (wire === null) {
          delete body["reasoning_effort"];
          // Merge into any existing kwargs so provider-supplied keys survive.
          const kwargs =
            body["chat_template_kwargs"] !== null &&
            typeof body["chat_template_kwargs"] === "object"
              ? (body["chat_template_kwargs"] as Record<string, unknown>)
              : {};
          kwargs.thinking = false;
          Object.assign(body, { chat_template_kwargs: kwargs });
        } else {
          body["reasoning_effort"] = wire;
        }
      }
    }
    if (stripReasoning && Array.isArray(body["messages"])) {
      for (const msg of body["messages"]) {
        if (msg !== null && typeof msg === "object")
          delete (msg as Record<string, unknown>)["reasoning_content"];
      }
    }
    const merged: BuiltRequest = { ...built, body: JSON.stringify(body) };
    return ensureAccept(merged);
  };

  // DeepSeek via NVIDIA NIM sends null for delta fields the upstream schema
  // requires to be non-null; every other provider's frames skip the reparse
  // and hit base.parseResponse exactly once instead of twice.
  const parseResponse: ProviderAdapter["parseResponse"] = (sseData: string) => {
    if (!needsDeepSeekPatch) return base.parseResponse(sseData);
    return base.parseResponse(normalizeNullDeltaFields(sseData));
  };

  return { ...base, buildRequest, parseResponse };
}
