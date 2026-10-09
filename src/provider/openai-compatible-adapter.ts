import { type BuiltRequest, type ProviderAdapter } from "@intx/inference";
import { createOpenAIAdapter } from "@intx/inference/providers";
import type { ReasoningEffort } from "../agent/profile-types.js";
import {
  DEEPSEEK_V4_MODEL_CARD,
  mapV4Effort,
  V4_STREAM_OPTIONS,
} from "./deepseek-v4-effort.js";
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
    const m = model.toLowerCase().trim();
    const stripReasoning = m.includes("deepseek");
    needsDeepSeekPatch = stripReasoning;
    if (!hasProviderOptions && !stripReasoning) return ensureAccept(built);

    const body = JSON.parse(built.body) as Record<string, unknown>;
    if (hasProviderOptions) Object.assign(body, providerOptions);

    // Merge a thinking toggle into a clone of the existing chat_template_kwargs
    // (never overwrite the object wholesale, and never mutate the caller's
    // providerOptions ref). The toggle is absent-only: a provider-supplied
    // thinking value wins over the V4 effort's implied value.
    const applyV4Thinking = (thinking: boolean): void => {
      const existing =
        body["chat_template_kwargs"] !== null &&
        typeof body["chat_template_kwargs"] === "object"
          ? (body["chat_template_kwargs"] as Record<string, unknown>)
          : {};
      const merged = { ...existing };
      merged.thinking ??= thinking;
      Object.assign(body, { chat_template_kwargs: merged });
    };
    // V4 drives its own effort ladder (none/xhigh/max) and encodes thinking via
    // chat_template_kwargs. `none` is a toggle, never a wire effort — drop
    // reasoning_effort and tell the encoder to skip the reasoning pass; xhigh/
    // max go out raw. Off-ladder efforts stay untouched, and an absent effort
    // is never invented here (no empty chat_template_kwargs either). Sampling
    // defaults and stream include_usage are absent-field-only — provider-set
    // values always win.
    if (/^deepseek-v4/i.test(m)) {
      let wireEffort: "xhigh" | "max" | null | undefined;
      if ("reasoning_effort" in body) {
        const raw = body["reasoning_effort"] as ReasoningEffort;
        wireEffort = mapV4Effort(raw);
        if (wireEffort === null) {
          delete body["reasoning_effort"];
          applyV4Thinking(false);
        } else if (wireEffort !== undefined) {
          body["reasoning_effort"] = wireEffort;
          applyV4Thinking(true);
        }
      }
      if (body["top_p"] === undefined)
        body["top_p"] = DEEPSEEK_V4_MODEL_CARD.topP;
      if (body["temperature"] === undefined)
        body["temperature"] = DEEPSEEK_V4_MODEL_CARD.temperature;
      // Absent-only, mirroring the sampling guard: provider-set stream_options
      // is never overwritten.
      body["stream_options"] ??= V4_STREAM_OPTIONS.stream_options;
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
