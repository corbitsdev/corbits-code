// Stable JSON so key insertion order does not create false progress between turns.
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(",")}}`;
}

/** Fingerprint of a turn's tool calls, or null when the turn has none. */
export function fingerprintToolCalls(
  content: ReadonlyArray<{ type: string; name?: string; arguments?: unknown }>,
): string | null {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type !== "tool_call") continue;
    const name = typeof block.name === "string" ? block.name : "";
    let args: unknown = block.arguments ?? {};
    // Some adapters hand arguments as a JSON string; normalize so fingerprints match.
    if (typeof args === "string") {
      try {
        args = JSON.parse(args) as unknown;
      } catch {
        // Keep the raw string when it is not valid JSON.
      }
    }
    parts.push(`${name}:${stableJson(args)}`);
  }
  if (parts.length === 0) return null;
  parts.sort();
  return parts.join("|");
}

export type ToolCallStreak = {
  lastFingerprint: string | undefined;
  consecutiveIdentical: number;
};

/** Advance consecutive-identical bookkeeping for one inference.done turn. */
export function nextToolCallStreak(
  prev: ToolCallStreak,
  fingerprint: string | null,
): ToolCallStreak {
  if (fingerprint === null) {
    return { lastFingerprint: undefined, consecutiveIdentical: 0 };
  }
  if (fingerprint === prev.lastFingerprint) {
    return {
      lastFingerprint: fingerprint,
      consecutiveIdentical: prev.consecutiveIdentical + 1,
    };
  }
  return { lastFingerprint: fingerprint, consecutiveIdentical: 1 };
}
