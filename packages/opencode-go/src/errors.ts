/**
 * Classify OpenCode Go gateway HTTP failures.
 *
 * Upstream shapes observed in the wild (and in anomalyco/opencode):
 * - 429 with `{ type:"error", error:{ type:"GoUsageLimitError"|"FreeUsageLimitError"|"RateLimitError", message } }`
 * - 429 with OpenAI-style `{ error:{ type:"rate_limit_error", code:"provider_rate_limit_exceeded", message } }`
 * - Occasional 400 with the same rate-limit / quota payload (mis-status from the gateway)
 *
 * Quota exhaustion is terminal for long windows; short provider rate limits remain retryable.
 */

export type GoErrorKind =
  "quota_exhausted" | "rate_limit" | "unauthorized" | "unavailable" | "unknown";

/** Subset of InferenceError.category used when reclassifying Go failures. */
export type GoErrorCategory = "quota_exhausted" | "retryable" | "auth" | "fatal";

export interface ParsedGoAPIError {
  kind: GoErrorKind;
  category: GoErrorCategory;
  message: string;
  typeName?: string;
  code?: string;
  retryAfterSec?: number;
  workspace?: string;
  statusCode: number;
}

const QUOTA_TYPE_NAMES = new Set([
  "GoUsageLimitError",
  "FreeUsageLimitError",
  "BlackUsageLimitError",
  "SubscriptionUsageLimitError",
]);

const RATE_LIMIT_TYPE_NAMES = new Set(["RateLimitError", "rate_limit_error"]);

const QUOTA_MESSAGE_MARKERS = [
  "usage limit",
  "quota exceeded",
  "subscription quota",
  "gousagelimit",
  "freeusagelimit",
] as const;

const RATE_LIMIT_MESSAGE_MARKERS = [
  "rate limit",
  "rate_limit",
  "provider rate limit",
  "provider_rate_limit",
  "too many requests",
] as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object") return undefined;
  return value as Record<string, unknown>;
}

function headerValue(
  headers: Headers | Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (headers === undefined) return undefined;
  if (typeof (headers as Headers).get === "function") {
    const v = (headers as Headers).get(name);
    return v === null ? undefined : v;
  }
  const rec = headers as Record<string, string>;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(rec)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

function parseRetryAfterSec(
  headers: Headers | Record<string, string> | undefined,
  body: Record<string, unknown> | undefined,
): number | undefined {
  const rawHeader = headerValue(headers, "retry-after");
  if (rawHeader !== undefined) {
    const n = Number(rawHeader);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  if (body !== undefined) {
    const meta = asRecord(body["metadata"]);
    if (meta !== undefined && typeof meta["retryAfter"] === "number") {
      return meta["retryAfter"];
    }
    if (typeof body["retry_after"] === "number") return body["retry_after"];
  }
  return undefined;
}

function extractErrorNode(body: unknown): {
  typeName?: string;
  code?: string;
  message: string;
  workspace?: string;
  root?: Record<string, unknown>;
} {
  const root = asRecord(body);
  if (root === undefined) {
    return { message: typeof body === "string" ? body : "" };
  }
  // Shape A: { type:"error", error:{ type, message }, metadata?:{ workspace } }
  const nested = asRecord(root["error"]);
  if (nested !== undefined) {
    const meta = asRecord(root["metadata"]);
    const out: {
      typeName?: string;
      code?: string;
      message: string;
      workspace?: string;
      root: Record<string, unknown>;
    } = {
      message:
        typeof nested["message"] === "string"
          ? nested["message"]
          : typeof root["message"] === "string"
            ? root["message"]
            : "",
      root,
    };
    if (typeof nested["type"] === "string") out.typeName = nested["type"];
    if (typeof nested["code"] === "string") out.code = nested["code"];
    if (typeof meta?.["workspace"] === "string") out.workspace = meta["workspace"];
    return out;
  }
  // Shape B: flat { type, message, code }
  const flat: {
    typeName?: string;
    code?: string;
    message: string;
    root: Record<string, unknown>;
  } = {
    message: typeof root["message"] === "string" ? root["message"] : "",
    root,
  };
  if (typeof root["type"] === "string") flat.typeName = root["type"];
  if (typeof root["code"] === "string") flat.code = root["code"];
  return flat;
}

function looksLikeQuota(
  typeName: string | undefined,
  code: string | undefined,
  message: string,
): boolean {
  if (typeName !== undefined && QUOTA_TYPE_NAMES.has(typeName)) return true;
  if (code !== undefined && /quota|usage_limit/i.test(code)) return true;
  const lower = message.toLowerCase();
  return QUOTA_MESSAGE_MARKERS.some((m) => lower.includes(m));
}

function looksLikeRateLimit(
  typeName: string | undefined,
  code: string | undefined,
  message: string,
): boolean {
  if (typeName !== undefined && RATE_LIMIT_TYPE_NAMES.has(typeName)) return true;
  if (code !== undefined && /rate_limit/i.test(code)) return true;
  const lower = message.toLowerCase();
  return RATE_LIMIT_MESSAGE_MARKERS.some((m) => lower.includes(m));
}

function userMessageFor(
  kind: GoErrorKind,
  original: string,
  retryAfterSec: number | undefined,
): string {
  if (kind === "quota_exhausted") {
    const reset =
      retryAfterSec !== undefined && retryAfterSec > 0
        ? ` Resets in ~${formatReset(retryAfterSec)}.`
        : "";
    return (
      (original.length > 0
        ? original
        : "OpenCode Go usage limit reached. Use free Zen models or wait for the window to reset.") +
      reset
    );
  }
  if (kind === "rate_limit") {
    const wait =
      retryAfterSec !== undefined && retryAfterSec > 0
        ? ` Retry after ~${formatReset(retryAfterSec)}.`
        : " Retry shortly.";
    return (original.length > 0 ? original : "OpenCode Go rate limit exceeded.") + wait;
  }
  if (kind === "unauthorized") {
    return original.length > 0
      ? original
      : "OpenCode Go authentication failed. Reconnect from /model (Alt+A).";
  }
  return original.length > 0 ? original : "OpenCode Go request failed.";
}

function formatReset(sec: number): string {
  if (sec < 60) return `${String(Math.ceil(sec))}s`;
  if (sec < 3600) return `${String(Math.ceil(sec / 60))}m`;
  if (sec < 86400) {
    const h = Math.floor(sec / 3600);
    const m = Math.ceil((sec % 3600) / 60);
    return m > 0 ? `${String(h)}h ${String(m)}m` : `${String(h)}h`;
  }
  const d = Math.floor(sec / 86400);
  const h = Math.ceil((sec % 86400) / 3600);
  return h > 0 ? `${String(d)}d ${String(h)}h` : `${String(d)}d`;
}

/**
 * Parse a Go gateway error body + status. Returns undefined when the payload
 * does not look Go-specific so callers can fall through to generic handling.
 */
export function parseGoAPIError(args: {
  statusCode: number;
  body: unknown;
  headers?: Headers | Record<string, string>;
}): ParsedGoAPIError | undefined {
  const { statusCode, body, headers } = args;
  const extracted = extractErrorNode(body);
  const { typeName, code, message, workspace, root } = extracted;
  const retryAfterSec = parseRetryAfterSec(headers, root);

  const quota = looksLikeQuota(typeName, code, message);
  const rateLimit = !quota && looksLikeRateLimit(typeName, code, message);

  // Quota before auth: the gateway has returned 403 with usage-limit bodies.
  // Clear quota markers must not be swallowed as unauthorized.
  // 400 is intentional — the gateway has been observed returning 400 for limit hits.
  if (
    quota &&
    (statusCode === 429 || statusCode === 402 || statusCode === 400 || statusCode === 403)
  ) {
    return {
      kind: "quota_exhausted",
      category: "quota_exhausted",
      message: userMessageFor("quota_exhausted", message, retryAfterSec),
      statusCode,
      ...(typeName !== undefined ? { typeName } : {}),
      ...(code !== undefined ? { code } : {}),
      ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
      ...(workspace !== undefined ? { workspace } : {}),
    };
  }

  // Provider / console rate limit (retryable). Same 400 quirk.
  if (rateLimit && (statusCode === 429 || statusCode === 400 || statusCode === 503)) {
    return {
      kind: "rate_limit",
      category: "retryable",
      message: userMessageFor("rate_limit", message, retryAfterSec),
      statusCode,
      ...(typeName !== undefined ? { typeName } : {}),
      ...(code !== undefined ? { code } : {}),
      ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
      ...(workspace !== undefined ? { workspace } : {}),
    };
  }

  // Auth after quota/rate-limit so marker-bearing 403s are not misclassified.
  if (statusCode === 401 || statusCode === 403) {
    return {
      kind: "unauthorized",
      category: "auth",
      message: userMessageFor("unauthorized", message, undefined),
      statusCode,
      ...(typeName !== undefined ? { typeName } : {}),
      ...(code !== undefined ? { code } : {}),
      ...(workspace !== undefined ? { workspace } : {}),
    };
  }

  // Bare 429 without body markers — treat as retryable rate limit.
  // Callers must only invoke parseGoAPIError for known-Go contexts; bare 429
  // from other proxies stays outside this path.
  if (statusCode === 429) {
    return {
      kind: "rate_limit",
      category: "retryable",
      message: userMessageFor("rate_limit", message, retryAfterSec),
      statusCode,
      ...(typeName !== undefined ? { typeName } : {}),
      ...(code !== undefined ? { code } : {}),
      ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
      ...(workspace !== undefined ? { workspace } : {}),
    };
  }

  if (statusCode === 404) {
    return {
      kind: "unavailable",
      category: "fatal",
      message: message.length > 0 ? message : "OpenCode Go endpoint not found.",
      statusCode,
      ...(typeName !== undefined ? { typeName } : {}),
    };
  }

  // Recognized Go type name on an unexpected status — still surface it.
  if (
    typeName !== undefined &&
    (QUOTA_TYPE_NAMES.has(typeName) || RATE_LIMIT_TYPE_NAMES.has(typeName))
  ) {
    const kind: GoErrorKind = QUOTA_TYPE_NAMES.has(typeName) ? "quota_exhausted" : "rate_limit";
    return {
      kind,
      category: kind === "quota_exhausted" ? "quota_exhausted" : "retryable",
      message: userMessageFor(kind, message, retryAfterSec),
      statusCode,
      typeName,
      ...(code !== undefined ? { code } : {}),
      ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
      ...(workspace !== undefined ? { workspace } : {}),
    };
  }

  return undefined;
}
