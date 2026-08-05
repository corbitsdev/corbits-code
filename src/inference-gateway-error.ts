import type { InferenceError } from "@intx/types/runtime";
import { isOpenCodeGoURL, parseGoAPIError } from "../packages/opencode-go/src/index.js";

export type InferenceErrorLike = {
  category: string;
  message?: string;
  statusCode?: number;
  raw?: unknown;
  retryAfterMs?: number;
  /** Optional request base/url when known — used to scope Go error reclassification. */
  requestURL?: string;
};

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
 * Reclassify OpenCode Go quota / rate-limit / auth failures when the body
 * carries Go-specific error types (or the gateway mis-statused a limit as 400).
 */
export function normalizeOpenCodeGoInferenceError(error: InferenceError): InferenceError {
  const statusCode = error.statusCode;
  if (statusCode === undefined) return error;

  const rawText = stringFromRaw(error.raw);
  const messageText = error.message ?? "";
  const bodyFromRaw =
    error.raw !== undefined && typeof error.raw === "object"
      ? error.raw
      : tryParseJSON(rawText.length > 0 ? rawText : messageText);
  const body =
    bodyFromRaw !== undefined
      ? bodyFromRaw
      : messageText.length > 0
        ? { error: { message: messageText } }
        : undefined;
  if (body === undefined) return error;

  // Accept Go-typed bodies without a URL, or any request aimed at the Go gateway.
  const looksGo =
    isOpenCodeGoURL(rawText) ||
    /GoUsageLimitError|FreeUsageLimitError|BlackUsageLimitError|provider_rate_limit_exceeded|Console Go|opencode\.ai\/zen\/go/i.test(
      `${messageText}\n${rawText}`,
    );
  if (!looksGo) return error;

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
export function normalizeInferenceErrorForRetry(error: InferenceError): InferenceError {
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
