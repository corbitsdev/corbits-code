// Chat Completions SSE frames from some backends send `null` for delta fields
// the upstream schema requires to be non-null (`role: string`, `tool_calls:
// array`): DeepSeek via NVIDIA NIM and OpenCode Go both do this. Deleting the
// null fields lets the stock OpenAI adapter parse the frame; fields that
// legitimately accept null (content, reasoning_content, etc.) are left alone.
//
// Shared by the openai-compatible and OpenCode Go adapters so the patch stays
// in one place.

/** Delta fields that must never be null in a valid Chat Completions frame. */
export const NULL_REJECTED_DELTA_FIELDS = ["role", "tool_calls"] as const;

/**
 * Delete null-valued non-nullable delta fields from a Chat Completions SSE
 * frame. Returns the input unchanged when the payload is not JSON, has no
 * `choices[].delta` objects, or contains no null fields to remove.
 */
export function normalizeNullDeltaFields(sseData: string): string {
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
    for (const field of NULL_REJECTED_DELTA_FIELDS) {
      if ((delta as Record<string, unknown>)[field] === null) {
        Reflect.deleteProperty(delta, field);
        normalized = true;
      }
    }
  }

  return normalized ? JSON.stringify(parsed) : sseData;
}
