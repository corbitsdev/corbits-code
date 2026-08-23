/**
 * Parse and format Codex Responses `usage_limit_reached` bodies.
 *
 * Live shape (HTTP 429):
 *   { detail: { error: { code, message, plan_type, resets_in_seconds } } }
 *
 * Harness extractErrorMessage only unwraps top-level `{ error: { message } }`,
 * so the nested detail is left on `InferenceError.raw` while the classified
 * message falls back to statusText. Retry and transcript paths re-read raw here.
 *
 * Matchers stay Codex-narrow: exact `usage_limit_*` codes only. Generic OpenAI
 * codes (`insufficient_quota`, `rate_limit_exceeded`) and loose "limit reached"
 * copy must not rebrand other providers as Codex.
 */

export interface CodexUsageLimitError {
  readonly code: string;
  readonly message: string;
  readonly planType?: string;
  readonly resetsInSeconds?: number;
}

/** Exact codes observed / expected from the Codex ChatGPT backend. */
const USAGE_LIMIT_CODES = new Set(["usage_limit_reached", "usage_limit_exceeded"]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function tryParseJSON(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function coerceBody(raw: unknown): unknown {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return undefined;
    return tryParseJSON(trimmed) ?? raw;
  }
  return raw;
}

function readErrorNode(body: unknown): Record<string, unknown> | undefined {
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

/**
 * Returns a structured usage-limit error when `raw` matches the Codex body.
 * Undefined for unrelated payloads (including other providers' quota 429s).
 */
export function parseCodexUsageLimitError(raw: unknown): CodexUsageLimitError | undefined {
  const body = coerceBody(raw);
  const node = readErrorNode(body);
  if (node === undefined) return undefined;

  const code = typeof node["code"] === "string" ? node["code"] : undefined;
  // Exact code only — no regex, no message-only fallback. OpenAI uses
  // insufficient_quota / rate_limit_exceeded; those must stay non-Codex.
  if (code === undefined || !USAGE_LIMIT_CODES.has(code)) return undefined;

  const message = typeof node["message"] === "string" ? node["message"] : "";

  const planType =
    typeof node["plan_type"] === "string"
      ? node["plan_type"]
      : typeof node["planType"] === "string"
        ? node["planType"]
        : undefined;

  const resetsRaw =
    node["resets_in_seconds"] ?? node["resetsInSeconds"] ?? node["reset_after_seconds"];
  const resetsInSeconds =
    typeof resetsRaw === "number" && Number.isFinite(resetsRaw) && resetsRaw >= 0
      ? Math.floor(resetsRaw)
      : undefined;

  return {
    code,
    message,
    ...(planType !== undefined ? { planType } : {}),
    ...(resetsInSeconds !== undefined ? { resetsInSeconds } : {}),
  };
}

/** `retryAfterMs` for the default retry policy; undefined when the body omits reset. */
export function codexUsageLimitRetryAfterMs(parsed: CodexUsageLimitError): number | undefined {
  if (parsed.resetsInSeconds === undefined) return undefined;
  if (parsed.resetsInSeconds <= 0) return 0;
  return parsed.resetsInSeconds * 1000;
}

export function formatResetETA(seconds: number): string {
  if (seconds <= 0) return "now";
  if (seconds < 60) return `${String(Math.ceil(seconds))}s`;
  if (seconds < 3600) return `~${String(Math.ceil(seconds / 60))}m`;
  if (seconds < 86_400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.ceil((seconds % 3600) / 60);
    return m > 0 ? `~${String(h)}h ${String(m)}m` : `~${String(h)}h`;
  }
  const d = Math.floor(seconds / 86_400);
  const h = Math.ceil((seconds % 86_400) / 3600);
  return h > 0 ? `~${String(d)}d ${String(h)}h` : `~${String(d)}d`;
}

export interface FormatCodexUsageLimitOpts {
  /** Active Codex profile name (from `codex/<profile>` provider id) when known. */
  readonly profile?: string;
}

/**
 * Operator-facing one-liner: which plan/profile hit the wall, when it resets,
 * and how to try another subscription.
 */
export function formatCodexUsageLimitMessage(
  parsed: CodexUsageLimitError,
  opts?: FormatCodexUsageLimitOpts,
): string {
  const who =
    opts?.profile !== undefined && opts.profile.length > 0
      ? `Codex profile "${opts.profile}"`
      : "Codex";
  const plan =
    parsed.planType !== undefined && parsed.planType.length > 0
      ? ` (${parsed.planType.replace(/_/g, " ")})`
      : "";
  const reset =
    parsed.resetsInSeconds !== undefined
      ? ` Resets in ${formatResetETA(parsed.resetsInSeconds)}.`
      : "";
  return `${who} usage limit reached${plan}.${reset} Switch profile with /model if another Codex subscription has quota.`;
}
