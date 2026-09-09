import type { BuiltRequest, ProviderAdapter } from "@intx/inference";
import { createOpenAICompatibleAdapter } from "./openai-compatible-adapter.js";
import { OPENCODE_SESSION_ID_OPTION, optionString } from "./responses-adapters.js";
import { normalizeNullDeltaFields } from "./sse-delta-patch.js";

type AdapterSource = Parameters<typeof createOpenAICompatibleAdapter>[0];

export function createOpenCodeGoAdapter(source: AdapterSource, quirks?: unknown): ProviderAdapter {
  const base = createOpenAICompatibleAdapter(source, quirks);
  const buildRequest: ProviderAdapter["buildRequest"] = (messages, model, options) => {
    const built = base.buildRequest(messages, model, options);
    const sessionId = optionString(options, OPENCODE_SESSION_ID_OPTION);
    if (sessionId === undefined) return built;
    const { [OPENCODE_SESSION_ID_OPTION]: _sessionId, ...body } = JSON.parse(built.body) as Record<
      string,
      unknown
    >;
    const headers: BuiltRequest["headers"] = {
      ...built.headers,
      "x-opencode-session": sessionId,
    };
    return { ...built, headers, body: JSON.stringify(body) };
  };
  return {
    ...base,
    buildRequest,
    parseResponse: (sseData) => base.parseResponse(normalizeNullDeltaFields(sseData)),
  };
}
