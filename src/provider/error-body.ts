/**
 * Shared JSON error-body reader behind the structured provider error
 * classifiers (Codex usage limits, gateway rate-limit normalization):
 * coerce a raw string-or-object body, locate the error node across the
 * shapes providers and gateways emit, and read body-carried reset windows.
 * The matchers that consume a node stay per-provider (Codex exact codes,
 * xAI substring markers); only the body-walking mechanics are shared here.
 */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

export function tryParseJSON(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** String bodies parse; non-empty non-JSON strings pass through untouched so
 * message-only classifiers still see them. */
export function coerceBody(raw: unknown): unknown {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return undefined;
    return tryParseJSON(trimmed) ?? raw;
  }
  return raw;
}

/**
 * Locate the error node in a coerced body: nested `detail.error` (Codex
 * live shape), fields directly under `detail`, top-level `error`, or a
 * flat `code` on the root. Undefined for non-JSON bodies without one.
 */
export function readErrorNode(
  body: unknown,
): Record<string, unknown> | undefined {
  const root = asRecord(body);
  if (root === undefined) return undefined;

  const detail = asRecord(root["detail"]);
  if (detail !== undefined) {
    const nested = asRecord(detail["error"]);
    if (nested !== undefined) return nested;
    // Some gateways put the fields directly under detail.
    if (typeof detail["code"] === "string") return detail;
  }

  const top = asRecord(root["error"]);
  if (top !== undefined) return top;

  if (typeof root["code"] === "string") return root;
  return undefined;
}

/** Body-carried reset window (`resets_in_seconds` et al.); undefined unless a
 * finite, non-negative number. */
export function resetSecondsFromNode(
  node: Record<string, unknown>,
): number | undefined {
  const resetsRaw =
    node["resets_in_seconds"] ??
    node["resetsInSeconds"] ??
    node["reset_after_seconds"];
  return typeof resetsRaw === "number" &&
    Number.isFinite(resetsRaw) &&
    resetsRaw >= 0
    ? Math.floor(resetsRaw)
    : undefined;
}
