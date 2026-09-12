import { type BuiltRequest, type ProviderAdapter } from "@intx/inference";
import { createAnthropicAdapter } from "@intx/inference/providers";
import {
  OPENCODE_SESSION_ID_OPTION,
  optionString,
} from "./opencode-session.js";

export const ZEN_MESSAGES_PROVIDER = "zen-messages";

type AdapterSource = Parameters<typeof createAnthropicAdapter>[0];

export function createZenAnthropicAdapter(
  source: AdapterSource,
  quirks?: unknown,
): ProviderAdapter {
  const base = createAnthropicAdapter(source, quirks);
  const buildRequest: ProviderAdapter["buildRequest"] = (
    messages,
    model,
    options,
  ) => {
    const built = base.buildRequest(messages, model, options);
    const sessionId = optionString(options, OPENCODE_SESSION_ID_OPTION);
    if (sessionId === undefined) return built;
    const headers: BuiltRequest["headers"] = {
      ...built.headers,
      "x-opencode-session": sessionId,
    };
    return { ...built, headers };
  };
  return { ...base, buildRequest };
}
