import type { InferenceError } from "@intx/types/runtime";
import {
  isOpenCodeGoProviderId,
  isOpenCodeGoURL,
  parseGoAPIError,
} from "../packages/opencode-go/src/index.js";
import {
  codexUsageLimitRetryAfterMs,
  formatCodexUsageLimitMessage,
  parseCodexUsageLimitError,
} from "./auth/codex/usage-limit-error.js";
import { codexProfileFromProviderName, isCodexProviderName } from "./config/codex-providers.js";
import { isXaiProviderName } from "./config/xai-providers.js";
import { isXaiGrokLeafProvider } from "./subagent/provider-family.js";

export interface InferenceErrorLike {
  category: string;
  message?: string;
  statusCode?: number;
  raw?: unknown;
  retryAfterMs?: number;
  /** Optional request base/url when known — used to scope Go error reclassification. */
  requestURL?: string;
  /** Provider catalog id when known (e.g. opencode-go, codex/abk-labs). */
  providerId?: string;
  /** Explicit OpenCode Go provider flag when known. */
  opencodeGo?: boolean;
}

/** Optional Go context callers may attach so bare 429s reclassify without body markers. */
export interface OpenCodeGoErrorContext {
  requestURL?: string;
  providerId?: string;
  opencodeGo?: boolean;
}

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
export const GATEWAY_OVERLOAD_USER_MESSAGE = "Inference gateway overloaded — retrying…";

/** User-visible line while the harness retries a short known-provider HTTP 429. */
export const RATE_LIMIT_USER_MESSAGE = "Rate limited — retrying…";

/** Body markers that mean a real usage/quota window, not a short rate limit. */
const XAI_QUOTA_BODY_MARKERS = [
  "insufficient_quota",
  "usage limit",
  "usage_limit",
  "quota exceeded",
  "quota exhausted",
  "exceeded your current quota",
  "billing details",
] as const;

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
  if (
    hasGatewayOverloadStatus(error) &&
    rawText.length > 0 &&
    !rawText.trimStart().startsWith("{")
  ) {
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
function isKnownOpenCodeGoError(
  error: InferenceErrorWithGoContext,
  rawText: string,
  messageText: string,
): boolean {
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

  const category = parsed.category === "auth" ? ("credential_failure" as const) : parsed.category;

  const retryAfterMs =
    parsed.retryAfterSec !== undefined ? parsed.retryAfterSec * 1000 : error.retryAfterMs;

  return {
    category,
    message: parsed.message,
    statusCode: parsed.statusCode,
    ...(error.raw !== undefined ? { raw: error.raw } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

function isKnownXaiProviderId(providerId: string | undefined): boolean {
  if (providerId === undefined || providerId.length === 0) return false;
  if (isXaiProviderName(providerId)) return true;
  return isXaiGrokLeafProvider({ providerName: providerId });
}

function textHasXaiQuotaMarkers(...parts: string[]): boolean {
  const combined = parts.join("\n").toLowerCase();
  return XAI_QUOTA_BODY_MARKERS.some((marker) => combined.includes(marker));
}

/**
 * True when a known-xAI HTTP 429 looks like a short rate limit rather than a
 * usage/quota window. Used by both retry normalization and transcript copy —
 * FRIENDLY_BY_CATEGORY would otherwise paint every quota_exhausted 429 as
 * "Quota exhausted" even when the policy remaps it to retryable.
 *
 * Discrimination is body markers for quota, not Retry-After length.
 */
export function isXaiShortRateLimitInferenceError(error: InferenceErrorLike): boolean {
  if (!isKnownXaiProviderId(error.providerId)) return false;
  if (error.statusCode !== 429) return false;
  if (error.category !== "quota_exhausted" && error.category !== "retryable") return false;
  if (textHasXaiQuotaMarkers(error.message ?? "", stringFromRaw(error.raw))) return false;
  return true;
}

/**
 * intx defaults bare 429 → quota_exhausted. For known-xAI / Grok contexts a
 * bare 429 (or rate-limit body without usage/quota markers) reclassifies as
 * retryable so moderate Retry-After values are not treated as long-window
 * quota exhaustion by the Corbits blind-wait abort.
 *
 * Clear usage/quota body markers keep quota_exhausted. Unknown providers are
 * never remapped.
 */
export function normalizeXaiRateLimitError(error: InferenceErrorWithGoContext): InferenceError {
  if (error.statusCode !== 429) return error;
  if (error.category !== "quota_exhausted") return error;
  if (!isKnownXaiProviderId(error.providerId)) return error;
  if (textHasXaiQuotaMarkers(error.message ?? "", stringFromRaw(error.raw))) return error;

  return {
    category: "retryable",
    message: RATE_LIMIT_USER_MESSAGE,
    statusCode: 429,
    ...(error.raw !== undefined ? { raw: error.raw } : {}),
    ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
  };
}

function parseCodexUsageLimitFromError(
  error: InferenceErrorLike,
): ReturnType<typeof parseCodexUsageLimitError> {
  const candidates: unknown[] = [];
  if (error.raw !== undefined) candidates.push(error.raw);
  if (typeof error.message === "string" && error.message.trim().startsWith("{")) {
    candidates.push(error.message);
  }

  for (const candidate of candidates) {
    const parsed = parseCodexUsageLimitError(candidate);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function isKnownCodexProviderId(providerId: string | undefined): boolean {
  return providerId !== undefined && isCodexProviderName(providerId);
}

/**
 * True when a known-Codex HTTP 429 looks like a short rate limit rather than a
 * `usage_limit_reached` window. Used by both retry normalization and transcript
 * copy — FRIENDLY_BY_CATEGORY would otherwise paint every quota_exhausted 429 as
 * "Quota exhausted" even when the policy remaps it to retryable.
 *
 * Discrimination is the existing Codex usage-limit parser, not Retry-After length
 * and not ChatGPT usage-limit prose without `usage_limit_reached`.
 */
export function isCodexShortRateLimitInferenceError(error: InferenceErrorLike): boolean {
  if (!isKnownCodexProviderId(error.providerId)) return false;
  if (error.statusCode !== 429) return false;
  if (error.category !== "quota_exhausted" && error.category !== "retryable") return false;
  if (parseCodexUsageLimitFromError(error) !== undefined) return false;
  return true;
}

/**
 * intx defaults bare 429 → quota_exhausted. For known-Codex contexts a bare 429
 * (or usage-limit prose without `usage_limit_reached`) reclassifies as retryable
 * so short ChatGPT 429s are not painted as a committed usage-limit window.
 *
 * Nested `detail.error.code === usage_limit_reached` stays quota_exhausted via
 * `normalizeCodexUsageLimitError`. Unknown / non-Codex providers are never remapped.
 */
export function normalizeCodexRateLimitError(error: InferenceErrorWithGoContext): InferenceError {
  if (error.statusCode !== 429) return error;
  if (error.category !== "quota_exhausted") return error;
  if (!isKnownCodexProviderId(error.providerId)) return error;
  if (parseCodexUsageLimitFromError(error) !== undefined) return error;

  return {
    category: "retryable",
    message: RATE_LIMIT_USER_MESSAGE,
    statusCode: 429,
    ...(error.raw !== undefined ? { raw: error.raw } : {}),
    ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
  };
}

/**
 * Lift Codex `usage_limit_reached` bodies onto quota_exhausted with a reset ETA
 * and profile-switch hint. The harness leaves nested `detail.error` on `raw`
 * while message falls back to statusText, so retry and transcript both re-read it.
 *
 * When providerId is known and not a Codex source, leave the error alone so
 * OpenAI/Go/etc. quota bodies never get Codex-branded copy.
 */
function normalizeCodexUsageLimitError(error: InferenceErrorWithGoContext): InferenceError {
  if (error.providerId !== undefined && !isCodexProviderName(error.providerId)) {
    return error;
  }

  const parsed = parseCodexUsageLimitFromError(error);
  if (parsed === undefined) return error;

  const profile =
    error.providerId !== undefined ? codexProfileFromProviderName(error.providerId) : undefined;
  const retryAfterMs = codexUsageLimitRetryAfterMs(parsed) ?? error.retryAfterMs;

  return {
    category: "quota_exhausted",
    message: formatCodexUsageLimitMessage(parsed, {
      ...(profile !== undefined ? { profile } : {}),
    }),
    statusCode: error.statusCode ?? 429,
    ...(error.raw !== undefined ? { raw: error.raw } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

/**
 * Reclassify gateway overload errors so the default retry policy treats them as
 * transient instead of aborting on protocol_mismatch. Also normalizes OpenCode
 * Go quota/rate-limit shapes (including HTTP 400 mis-status), known-xAI short
 * 429s, Codex usage limits (nested detail.error with resets_in_seconds), and
 * known-Codex short 429s that are not usage_limit_reached.
 */
export function normalizeInferenceErrorForRetry(
  error: InferenceErrorWithGoContext,
): InferenceError {
  const goNormalized = normalizeOpenCodeGoInferenceError(error);
  if (goNormalized !== error) return goNormalized;

  const xaiNormalized = normalizeXaiRateLimitError(error);
  if (xaiNormalized !== error) return xaiNormalized;

  const codexNormalized = normalizeCodexUsageLimitError(error);
  if (codexNormalized !== error) return codexNormalized;

  const codexRateLimit = normalizeCodexRateLimitError(error);
  if (codexRateLimit !== error) return codexRateLimit;

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

function isInferenceErrorCategory(category: string): category is InferenceError["category"] {
  return (
    category === "fatal" ||
    category === "retryable" ||
    category === "context_overflow" ||
    category === "credential_failure" ||
    category === "quota_exhausted" ||
    category === "aborted" ||
    category === "timeout" ||
    category === "protocol_mismatch"
  );
}

/** Normalize a provider diagnostic once for terminal presentation without dropping context fields. */
export function normalizeInferenceErrorForTerminal(
  error: InferenceErrorLike,
  fallbackProviderId: string,
): InferenceErrorLike {
  const contextual = {
    ...error,
    providerId: error.providerId ?? fallbackProviderId,
  };
  if (!isInferenceErrorCategory(contextual.category)) return contextual;
  const normalized = normalizeInferenceErrorForRetry({
    ...contextual,
    category: contextual.category,
    message: contextual.message ?? "Inference error",
  });
  return {
    ...contextual,
    ...normalized,
    providerId: contextual.providerId,
  };
}

export function gatewayOverloadUserMessage(error: InferenceErrorLike): string {
  if (!isGatewayOverloadInferenceError(error)) return error.message ?? "Inference error";
  return GATEWAY_OVERLOAD_USER_MESSAGE;
}
