import type { ProviderAdapter } from "@intx/inference";
import { createOpenAICompatibleAdapter } from "./openai-compatible-adapter.js";

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

export function createOpenCodeGoAdapter(source: AdapterSource, quirks?: unknown): ProviderAdapter {
  const base = createOpenAICompatibleAdapter(source, quirks);
  return {
    ...base,
    parseResponse: (sseData) => base.parseResponse(normalizeNullDeltaFields(sseData)),
  };
}
