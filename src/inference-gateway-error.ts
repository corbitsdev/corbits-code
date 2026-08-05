import type { InferenceError } from "@intx/types/runtime";
import {
  isOpenCodeGoProviderId,
  isOpenCodeGoURL,
  parseGoAPIError,
} from "../packages/opencode-go/src/index.js";

export type InferenceErrorLike = {
  category: string;
  message?: string;
  statusCode?: number;
  raw?: unknown;
  retryAfterMs?: number;
  /** Optional request base/url when known — used to scope Go error reclassification. */
  requestURL?: string;
  /** Provider catalog id when known (e.g. opencode-go). */
  providerId?: string;
  /** Explicit OpenCode Go provider flag when known. */
  opencodeGo?: boolean;
};

/** Optional Go context callers may attach so bare 429s reclassify without body markers. */
export type OpenCodeGoErrorContext = {
  requestURL?: string;
  providerId?: string;
  opencodeGo?: boolean;
};

export type InferenceErrorWithGoContext = InferenceError & OpenCodeGoErrorContext;

const GATEWAY_OVERLOAD_STATUS_CODES = new Set([502, 503, 504]);

const GATEWAY_OVERLOAD_TEXT_MARKERS = [
  "service unavailable",
  "error code 1101",
  "cloudflare",
  "bad gateway",
  "gateway timeout",
] as const;

/** User-visible line while the harness retries a transient gateway overload. */
export const GATEWAY_OVERLOAD_USER_MESSAGE =
  "Inference gateway overloaded — retrying…";

function stringFromRaw(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw instanceof Error) return raw.message;
  if (raw === undefined || raw === null) return "";
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

/** True when the payload looks like an HTML error page rather than API JSON/SSE. */
export function looksLikeHtmlGatewayBody(text: string): boolean {
  const trimmed = text.trimStart().slice(0, 512).toLowerCase();
  if (trimmed.length === 0) return false;
  return (
    trimmed.startsWith("<!doctype html") ||
    trimmed.startsWith("<html") ||
    (trimmed.includes("<head") && trimmed.includes("<body"))
  );
}

function textSuggestsGatewayOverload(...parts: string[]): boolean {
  const combined = parts.join("\n").toLowerCase();
  if (combined.includes("503")) return true;
  return GATEWAY_OVERLOAD_TEXT_MARKERS.some((marker) => combined.includes(marker));
}

function hasGatewayOverloadStatus(error: InferenceErrorLike): boolean {
  if (error.statusCode !== undefined && GATEWAY_OVERLOAD_STATUS_CODES.has(error.statusCode)) {
    return true;
  }
  return textSuggestsGatewayOverload(error.message ?? "", stringFromRaw(error.raw));
}

/**
 * Detect HTML-bodied 503 / reverse-proxy overload responses that upstream may
 * classify as protocol_mismatch when the stream body is not valid SSE/JSON.
 */
export function isGatewayOverloadInferenceError(error: InferenceErrorLike): boolean {
  const rawText = stringFromRaw(error.raw);
  const htmlLike =
    looksLikeHtmlGatewayBody(rawText) || looksLikeHtmlGatewayBody(error.message ?? "");

  if (error.category === "retryable" || error.category === "timeout") {
    return htmlLike && hasGatewayOverloadStatus(error);
  }

  if (error.category !== "protocol_mismatch") return false;

  if (htmlLike && hasGatewayOverloadStatus(error)) return true;

  // Malformed SSE where the first chunk is a plain HTML 503 page (no doctype).
  if (hasGatewayOverloadStatus(error) && rawText.length > 0 && !rawText.trimStart().startsWith("{")) {
    return textSuggestsGatewayOverload(rawText) || htmlLike;
  }

  return false;
}

function tryParseJSON(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * True when the error is known to come from OpenCode Go — via explicit
 * provider context (id / flag / request URL) or Go-specific body markers.
 * Do not match bare `provider_rate_limit_exceeded` alone; other proxies use it.
 */
function isKnownOpenCodeGoError(error: InferenceErrorWithGoContext, rawText: string, messageText: string): boolean {
  if (error.opencodeGo === true) return true;
  if (isOpenCodeGoProviderId(error.providerId)) return true;
  if (isOpenCodeGoURL(error.requestURL)) return true;
  if (isOpenCodeGoURL(rawText)) return true;
  return /GoUsageLimitError|FreeUsageLimitError|BlackUsageLimitError|Console Go|opencode\.ai\/zen\/go/i.test(
    `${messageText}\n${rawText}`,
  );
}

/**
 * Reclassify OpenCode Go quota / rate-limit / auth failures when the request is
 * known to be Go (provider id / opencodeGo / requestURL) or the body carries
 * Go-specific error types (including HTTP 400/403 mis-status).
 *
 * intx defaults bare 429 → quota_exhausted; for known-Go contexts a bare 429
 * reclassifies as retryable rate_limit so short limits are not treated as
 * long-window quota exhaustion.
 */
export function normalizeOpenCodeGoInferenceError(
  error: InferenceErrorWithGoContext,
): InferenceError {
  const statusCode = error.statusCode;
  if (statusCode === undefined) return error;

  const rawText = stringFromRaw(error.raw);
  const messageText = error.message ?? "";
  if (!isKnownOpenCodeGoError(error, rawText, messageText)) return error;

  const bodyFromRaw =
    error.raw !== undefined && typeof error.raw === "object"
      ? error.raw
      : tryParseJSON(rawText.length > 0 ? rawText : messageText);
  // Empty body is fine for known-Go bare 429/403 reclassification.
  const body =
    bodyFromRaw !== undefined
      ? bodyFromRaw
      : messageText.length > 0
        ? { error: { message: messageText } }
        : {};

  const parsed = parseGoAPIError({ statusCode, body });
  if (parsed === undefined) return error;

  const category =
    parsed.category === "auth"
      ? ("credential_failure" as const)
      : parsed.category;

  const retryAfterMs =
    parsed.retryAfterSec !== undefined
      ? parsed.retryAfterSec * 1000
      : error.retryAfterMs;

  return {
    category,
    message: parsed.message,
    statusCode: parsed.statusCode,
    ...(error.raw !== undefined ? { raw: error.raw } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

/**
 * Reclassify gateway overload errors so the default retry policy treats them as
 * transient instead of aborting on protocol_mismatch. Also normalizes OpenCode
 * Go quota/rate-limit shapes (including HTTP 400 mis-status).
 */
export function normalizeInferenceErrorForRetry(
  error: InferenceErrorWithGoContext,
): InferenceError {
  const goNormalized = normalizeOpenCodeGoInferenceError(error);
  if (goNormalized !== error) return goNormalized;

  if (!isGatewayOverloadInferenceError(error)) return error;
  if (error.category === "retryable" || error.category === "timeout") return error;

  return {
    category: "retryable",
    message: GATEWAY_OVERLOAD_USER_MESSAGE,
    statusCode: error.statusCode ?? 503,
    ...(error.raw !== undefined ? { raw: error.raw } : {}),
    ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
  };
}

export function gatewayOverloadUserMessage(error: InferenceErrorLike): string {
  if (!isGatewayOverloadInferenceError(error)) return error.message ?? "Inference error";
  return GATEWAY_OVERLOAD_USER_MESSAGE;
}
