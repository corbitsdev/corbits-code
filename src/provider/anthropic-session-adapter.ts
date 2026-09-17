import { type BuiltRequest, type ProviderAdapter } from "@intx/inference";
import { createAnthropicAdapter } from "@intx/inference/providers";
import {
  OPENCODE_SESSION_ID_OPTION,
  optionString,
} from "./opencode-session.js";

export const ZEN_MESSAGES_PROVIDER = "zen-messages";
export const OPENCODE_GO_MESSAGES_PROVIDER = "opencode-go-messages";

type AdapterSource = Parameters<typeof createAnthropicAdapter>[0];

export function createSessionHeaderAnthropicAdapter(
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

// Both providers share the session-header wrapper above; keep both export
// names for the adapter registration table.
export const createZenAnthropicAdapter = createSessionHeaderAnthropicAdapter;

export const createOpenCodeGoAnthropicAdapter =
  createSessionHeaderAnthropicAdapter;
