import type { InferenceError } from "@intx/types/runtime";

export type InferenceErrorLike = {
  category: string;
  message?: string;
  statusCode?: number;
  raw?: unknown;
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

/**
 * Reclassify gateway overload errors so the default retry policy treats them as
 * transient instead of aborting on protocol_mismatch.
 */
export function normalizeInferenceErrorForRetry(error: InferenceError): InferenceError {
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