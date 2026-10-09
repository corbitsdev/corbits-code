import { type BuiltRequest, type ProviderAdapter } from "@intx/inference";
import { createOpenAIAdapter } from "@intx/inference/providers";
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
    // DeepSeek's hosted API historically returned HTTP 400 if
    // `reasoning_content` appeared in input messages, whereas the base adapter
    // emits it for any model with thinking enabled. DeepSeek V4 Flash is the
    // exception: its encoder keeps every turn's reasoning when tools are
    // present, so stripping it renders each prior tool turn as an empty
    // thinking response and the model copies that and stops thinking.
    const v4Flash = isDeepSeekV4Flash(model);
    const stripReasoning = model.toLowerCase().includes("deepseek") && !v4Flash;
    needsDeepSeekPatch = model.toLowerCase().includes("deepseek");
    const v4FlashParams = v4Flash;
    if (!hasProviderOptions && !stripReasoning && !v4FlashParams)
      return ensureAccept(built);

    const body = JSON.parse(built.body) as Record<string, unknown>;
    if (hasProviderOptions) Object.assign(body, providerOptions);
    if (stripReasoning && Array.isArray(body["messages"])) {
      for (const msg of body["messages"]) {
        if (msg !== null && typeof msg === "object")
          delete (msg as Record<string, unknown>)["reasoning_content"];
      }
    }
    if (v4FlashParams) applyDeepSeekV4FlashParams(body);
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

/** DeepSeek V4 Flash on any OpenAI-compatible host (SGLang, vLLM, gateway). */
export function isDeepSeekV4Flash(model: string): boolean {
  return /(^|\/)deepseek-v4-flash/i.test(model.trim());
}

// DeepSeek V4 understands exactly three reasoning_effort levels (low, high,
// max); its reference encoder asserts on anything else. Corbits' generic
// ladder (minimal/low/medium/high/xhigh/max) is folded onto those three.
const DSV4_EFFORT: Record<string, "low" | "high" | "max"> = {
  minimal: "low",
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max",
};

/**
 * Wire shape the DeepSeek V4 Flash model card asks for, applied to an
 * already-built Chat Completions body:
 * - thinking is driven by `chat_template_kwargs.thinking` (SGLang and vLLM
 *   both read it); `reasoning_effort` "none"/"off" or absent means chat mode.
 * - effort folds onto low/high/max.
 * - thinking mode samples at temperature 1.0 / top_p 0.95 (agentic); an
 *   explicitly configured temperature/top_p still wins.
 * - stream usage is requested so token counts are observable.
 */
export function applyDeepSeekV4FlashParams(
  body: Record<string, unknown>,
): void {
  const raw = body["reasoning_effort"];
  const effort = typeof raw === "string" ? raw.toLowerCase() : undefined;
  const thinking =
    effort !== undefined && effort !== "none" && effort !== "off";
  const existingKwargs =
    body["chat_template_kwargs"] !== null &&
    typeof body["chat_template_kwargs"] === "object"
      ? (body["chat_template_kwargs"] as Record<string, unknown>)
      : {};
  body["chat_template_kwargs"] = { ...existingKwargs, thinking };
  if (thinking) {
    body["reasoning_effort"] = DSV4_EFFORT[effort] ?? "high";
    if (body["temperature"] === undefined) body["temperature"] = 1.0;
    if (body["top_p"] === undefined) body["top_p"] = 0.95;
  } else {
    delete body["reasoning_effort"];
  }
  if (body["stream"] === true && body["stream_options"] === undefined) {
    body["stream_options"] = { include_usage: true };
  }
}
