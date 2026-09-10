import type { BuiltRequest, ProviderAdapter } from "@intx/inference";
import { createOpenAICompatibleAdapter } from "./openai-compatible-adapter.js";
import { OPENCODE_SESSION_ID_OPTION, optionString } from "./opencode-session.js";

type AdapterSource = Parameters<typeof createOpenAICompatibleAdapter>[0];

const NULL_DELTA_FIELDS = ["role", "tool_calls"] as const;

function normalizeNullDeltaFields(sseData: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sseData);
  } catch {
    return sseData;
  }
  if (parsed === null || typeof parsed !== "object") return sseData;

  const choices = (parsed as Record<string, unknown>)["choices"];
  if (!Array.isArray(choices)) return sseData;

  let normalized = false;
  for (const choice of choices) {
    if (choice === null || typeof choice !== "object") continue;
    const delta = (choice as Record<string, unknown>)["delta"];
    if (delta === null || typeof delta !== "object") continue;
    for (const field of NULL_DELTA_FIELDS) {
      if ((delta as Record<string, unknown>)[field] === null) {
        Reflect.deleteProperty(delta, field);
        normalized = true;
      }
    }
  }

  return normalized ? JSON.stringify(parsed) : sseData;
}

export function createOpenCodeGoAdapter(
  source: AdapterSource,
  quirks?: unknown,
): ProviderAdapter {
  const base = createOpenAICompatibleAdapter(source, quirks);
  const buildRequest: ProviderAdapter["buildRequest"] = (
    messages,
    model,
    options,
  ) => {
    const built = base.buildRequest(messages, model, options);
    const sessionId = optionString(options, OPENCODE_SESSION_ID_OPTION);
    if (sessionId === undefined) return built;
    const { [OPENCODE_SESSION_ID_OPTION]: _sessionId, ...body } = JSON.parse(
      built.body,
    ) as Record<string, unknown>;
    const headers: BuiltRequest["headers"] = {
      ...built.headers,
      "x-opencode-session": sessionId,
    };
    return { ...built, headers, body: JSON.stringify(body) };
  };
  return {
    ...base,
    buildRequest,
    parseResponse: (sseData) =>
      base.parseResponse(normalizeNullDeltaFields(sseData)),
  };
}
