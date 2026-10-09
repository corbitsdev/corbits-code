import { type ProviderAdapter } from "@intx/inference";
import { createOpenAICompatibleAdapter } from "./openai-compatible-adapter.js";
import {
  DEEPSEEK_V4_MODEL_CARD,
  isDeepSeekV4Model,
  mapV4Effort,
  V4_STREAM_OPTIONS,
} from "./deepseek-v4-effort.js";

export const DEEPSEEK_V4_PROVIDER = "deepseek-v4";

type AdapterSource = Parameters<typeof createOpenAICompatibleAdapter>[0];

// Wraps the patched openai-compatible adapter so V4 requests inherit the
// providerOptions merge, NIM null-delta patch, and Accept header; this layer
// only applies the V4 effort/sampling/stream quirks to the built body.
export function createDeepSeekV4Adapter(
  source: AdapterSource,
): ProviderAdapter {
  const base = createOpenAICompatibleAdapter(source);

  const buildRequest: ProviderAdapter["buildRequest"] = (
    messages,
    model,
    options,
  ) => {
    const req = base.buildRequest(messages, model, options);
    if (!isDeepSeekV4Model(model)) return req;
    const body = JSON.parse(req.body) as Record<string, unknown>;

    // V4 effort ladder (none/xhigh/max): none drops reasoning_effort and
    // turns thinking off; xhigh/max go out raw with thinking on; off-ladder
    // or absent efforts are left untouched.
    if ("reasoning_effort" in body) {
      const effort = body["reasoning_effort"] as Parameters<
        typeof mapV4Effort
      >[0];
      const wire = mapV4Effort(effort);
      if (wire === null) {
        delete body["reasoning_effort"];
        mergeThinking(body, false);
      } else if (wire !== undefined) {
        body["reasoning_effort"] = wire;
        mergeThinking(body, true);
      }
    }

    if (body["top_p"] === undefined)
      body["top_p"] = DEEPSEEK_V4_MODEL_CARD.topP;
    if (body["temperature"] === undefined)
      body["temperature"] = DEEPSEEK_V4_MODEL_CARD.temperature;
    body["stream_options"] ??= V4_STREAM_OPTIONS.stream_options;

    return { ...req, body: JSON.stringify(body) };
  };

  return { ...base, buildRequest };
}

// chat_template_kwargs clone with an absent-only thinking toggle (never mutate
// the caller's providerOptions; provider-set thinking wins).
function mergeThinking(body: Record<string, unknown>, thinking: boolean): void {
  const existing =
    body["chat_template_kwargs"] !== null &&
    typeof body["chat_template_kwargs"] === "object"
      ? (body["chat_template_kwargs"] as Record<string, unknown>)
      : {};
  const merged = { ...existing };
  merged.thinking ??= thinking;
  Object.assign(body, { chat_template_kwargs: merged });
}
