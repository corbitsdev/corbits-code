// Some OpenAI-shaped streams send null for delta fields the upstream schema
// requires to be non-null (role: string, tool_calls: array). Fields that
// legitimately accept null (content, reasoning_content, etc.) stay untouched.
export const NULL_DELTA_FIELDS = ["role", "tool_calls"] as const;

export function normalizeNullDeltaFields(
  sseData: string,
  fields: readonly string[] = NULL_DELTA_FIELDS,
): string {
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
    for (const field of fields) {
      if ((delta as Record<string, unknown>)[field] === null) {
        Reflect.deleteProperty(delta, field);
        normalized = true;
      }
    }
  }

  return normalized ? JSON.stringify(parsed) : sseData;
}
