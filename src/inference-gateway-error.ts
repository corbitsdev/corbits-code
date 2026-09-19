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
import {
  codexProfileFromProviderName,
  isCodexProviderName,
} from "./config/codex-providers.js";
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

export type InferenceErrorWithGoContext = InferenceError &
  OpenCodeGoErrorContext;

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

/**
 * User-visible line for a short known-provider HTTP 429. Worded without
 * "retrying": this message also surfaces terminally after the harness has
 * exhausted its retries, where claiming an ongoing retry is wrong.
 */
export const RATE_LIMIT_USER_MESSAGE = "Rate limited";

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

/**
 * Marker-list check over the joined, lowercased parts: true when any marker
 * is a substring of the combined text. Shared by the gateway-overload, xAI
 * quota, and xAI capacity detectors.
 */
function combinedTextIncludesMarker(
  parts: string[],
  markers: readonly string[],
): boolean {
  const combined = parts.join("\n").toLowerCase();
  return markers.some((marker) => combined.includes(marker));
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
  return combinedTextIncludesMarker(parts, GATEWAY_OVERLOAD_TEXT_MARKERS);
}

function hasGatewayOverloadStatus(error: InferenceErrorLike): boolean {
  if (
    error.statusCode !== undefined &&
    GATEWAY_OVERLOAD_STATUS_CODES.has(error.statusCode)
  ) {
    return true;
  }
  return textSuggestsGatewayOverload(
    error.message ?? "",
    stringFromRaw(error.raw),
  );
}

/**
 * Detect HTML-bodied 503 / reverse-proxy overload responses that upstream may
 * classify as protocol_mismatch when the stream body is not valid SSE/JSON.
 */
export function isGatewayOverloadInferenceError(
  error: InferenceErrorLike,
): boolean {
  const rawText = stringFromRaw(error.raw);
  const htmlLike =
    looksLikeHtmlGatewayBody(rawText) ||
    looksLikeHtmlGatewayBody(error.message ?? "");

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

function isKnownXaiProviderId(providerId: string | undefined): boolean {
  if (providerId === undefined || providerId.length === 0) return false;
  if (isXaiProviderName(providerId)) return true;
  return isXaiGrokLeafProvider({ providerName: providerId });
}

function textHasXaiQuotaMarkers(...parts: string[]): boolean {
  return combinedTextIncludesMarker(parts, XAI_QUOTA_BODY_MARKERS);
}

/**
 * User-visible line for an attributable xAI / Grok capacity error. Worded
 * without "retrying" for the same reason as RATE_LIMIT_USER_MESSAGE — it also
 * surfaces terminally once retries are exhausted.
 */
export const XAI_CAPACITY_USER_MESSAGE = "xAI at capacity";

/**
 * xAI / Grok capacity and overload phrases that arrive as protocol_mismatch
 * (message-only or JSON raw) when the stream is not valid SSE. Exact
 * "Service temporarily unavailable" is intentional — do not widen to the
 * gateway "service unavailable" substring, which would rematch quota copy.
 */
const XAI_CAPACITY_TEXT_MARKERS = [
  "currently at capacity",
  "overloaded",
  "high demand",
] as const;

const XAI_CAPACITY_EXACT_MESSAGES = new Set([
  "service temporarily unavailable",
]);

/**
 * Exact-match only — never substring, so quota-suffixed copy stays out. Checks
 * the part itself and common JSON message fields, since intx puts the server
 * body on `raw` while `message` carries parser detail.
 */
function isXaiCapacityExactPhrase(part: string): boolean {
  if (XAI_CAPACITY_EXACT_MESSAGES.has(part.trim().toLowerCase())) return true;
  const parsed = tryParseJSON(part);
  if (typeof parsed !== "object" || parsed === null) return false;
  const record = parsed as Record<string, unknown>;
  const nested = record.error;
  const candidates = [
    record.message,
    typeof nested === "string" ? nested : undefined,
    typeof nested === "object" && nested !== null
      ? (nested as Record<string, unknown>).message
      : undefined,
  ];
  return candidates.some(
    (candidate) =>
      typeof candidate === "string" &&
      XAI_CAPACITY_EXACT_MESSAGES.has(candidate.trim().toLowerCase()),
  );
}

function textSuggestsXaiCapacity(...parts: string[]): boolean {
  if (combinedTextIncludesMarker(parts, XAI_CAPACITY_TEXT_MARKERS)) {
    return true;
  }
  return parts.some(isXaiCapacityExactPhrase);
}

/**
 * Remap attributable xAI / Grok capacity protocol_mismatch errors to retryable.
 * Unknown providers and OpenCode Go stay terminal. Quota markers anywhere in
 * the copy veto the remap — mixed capacity+quota text stays a real quota error.
 */
export function normalizeXaiCapacityError(
  error: InferenceErrorWithGoContext,
): InferenceError {
  if (error.category !== "protocol_mismatch") return error;
  if (!isKnownXaiProviderId(error.providerId)) return error;
  const messageText = error.message ?? "";
  const rawText = stringFromRaw(error.raw);
  if (textHasXaiQuotaMarkers(messageText, rawText)) return error;
  if (!textSuggestsXaiCapacity(messageText, rawText)) return error;

  return {
    category: "retryable",
    message: XAI_CAPACITY_USER_MESSAGE,
    statusCode: error.statusCode ?? 503,
    ...(error.raw !== undefined ? { raw: error.raw } : {}),
    ...(error.retryAfterMs !== undefined
      ? { retryAfterMs: error.retryAfterMs }
      : {}),
  };
}

/**
 * Shared short-rate-limit predicate behind the twin provider checks: a known
 * provider's HTTP 429 whose category is quota_exhausted (or already remapped
 * retryable) and whose body carries no usage-limit markers. Provider identity
 * and the usage-limit veto differ per provider; check order is fixed.
 */
function isShortRateLimitInferenceError(
  error: InferenceErrorLike,
  isKnownProvider: (providerId: string | undefined) => boolean,
  isUsageLimit: (error: InferenceErrorLike) => boolean,
): boolean {
  if (!isKnownProvider(error.providerId)) return false;
  if (error.statusCode !== 429) return false;
  if (error.category !== "quota_exhausted" && error.category !== "retryable")
    return false;
  if (isUsageLimit(error)) return false;
  return true;
}

function hasXaiQuotaMarkers(error: InferenceErrorLike): boolean {
  return textHasXaiQuotaMarkers(error.message ?? "", stringFromRaw(error.raw));
}

/**
 * True when a known-xAI HTTP 429 looks like a short rate limit rather than a
 * usage/quota window. Used by both retry normalization and transcript copy —
 * FRIENDLY_BY_CATEGORY would otherwise paint every quota_exhausted 429 as
 * "Quota exhausted" even when the policy remaps it to retryable.
 *
 * Discrimination is body markers for quota, not Retry-After length.
 */
export function isXaiShortRateLimitInferenceError(
  error: InferenceErrorLike,
): boolean {
  return isShortRateLimitInferenceError(
    error,
    isKnownXaiProviderId,
    hasXaiQuotaMarkers,
  );
}

/**
 * Shared early-return chain and return skeleton behind the twin rate-limit
 * normalizers: non-429s, non-quota categories, unknown providers, and bodies
 * with usage-limit markers pass through untouched; a bare (or marker-free)
 * 429 becomes retryable with scrubbed rate-limit copy.
 */
function normalizeProviderRateLimitError(
  error: InferenceErrorWithGoContext,
  isKnownProvider: (providerId: string | undefined) => boolean,
  isUsageLimit: (error: InferenceErrorLike) => boolean,
): InferenceError {
  if (error.statusCode !== 429) return error;
  if (error.category !== "quota_exhausted") return error;
  if (!isKnownProvider(error.providerId)) return error;
  if (isUsageLimit(error)) return error;

  return {
    category: "retryable",
    message: RATE_LIMIT_USER_MESSAGE,
    statusCode: 429,
    ...(error.raw !== undefined ? { raw: error.raw } : {}),
    ...(error.retryAfterMs !== undefined
      ? { retryAfterMs: error.retryAfterMs }
      : {}),
  };
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
export function normalizeXaiRateLimitError(
  error: InferenceErrorWithGoContext,
): InferenceError {
  return normalizeProviderRateLimitError(
    error,
    isKnownXaiProviderId,
    hasXaiQuotaMarkers,
  );
}

export function parseCodexUsageLimitFromError(
  error: InferenceErrorLike,
): ReturnType<typeof parseCodexUsageLimitError> {
  const candidates: unknown[] = [];
  if (error.raw !== undefined) candidates.push(error.raw);
  if (
    typeof error.message === "string" &&
    error.message.trim().startsWith("{")
  ) {
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

function hasCodexUsageLimit(error: InferenceErrorLike): boolean {
  return parseCodexUsageLimitFromError(error) !== undefined;
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
export function isCodexShortRateLimitInferenceError(
  error: InferenceErrorLike,
): boolean {
  return isShortRateLimitInferenceError(
    error,
    isKnownCodexProviderId,
    hasCodexUsageLimit,
  );
}

/**
 * intx defaults bare 429 → quota_exhausted. For known-Codex contexts a bare 429
 * (or usage-limit prose without `usage_limit_reached`) reclassifies as retryable
 * so short ChatGPT 429s are not painted as a committed usage-limit window.
 *
 * Nested `detail.error.code === usage_limit_reached` stays quota_exhausted via
 * `normalizeCodexUsageLimitError`. Unknown / non-Codex providers are never remapped.
 */
export function normalizeCodexRateLimitError(
  error: InferenceErrorWithGoContext,
): InferenceError {
  return normalizeProviderRateLimitError(
    error,
    isKnownCodexProviderId,
    hasCodexUsageLimit,
  );
}

/**
 * Lift Codex `usage_limit_reached` bodies onto quota_exhausted with a reset ETA
 * and profile-switch hint. The harness leaves nested `detail.error` on `raw`
 * while message falls back to statusText, so retry and transcript both re-read it.
 *
 * When providerId is known and not a Codex source, leave the error alone so
 * OpenAI/Go/etc. quota bodies never get Codex-branded copy.
 */
function normalizeCodexUsageLimitError(
  error: InferenceErrorWithGoContext,
): InferenceError {
  if (
    error.providerId !== undefined &&
    !isCodexProviderName(error.providerId)
  ) {
    return error;
  }

  const parsed = parseCodexUsageLimitFromError(error);
  if (parsed === undefined) return error;

  const profile =
    error.providerId !== undefined
      ? codexProfileFromProviderName(error.providerId)
      : undefined;
  const retryAfterMs =
    codexUsageLimitRetryAfterMs(parsed) ?? error.retryAfterMs;

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
 * Positive auth-rejection signals for the Codex credential-404 classifier. A
 * known-Codex fatal 404 reclassifies to credential_failure ONLY when the
 * message or raw body carries one of these markers — bare / routing / config
 * 404s and genuine unknown-model rejections stay fatal with switch-models
 * guidance. Negative unknown-model matching is deliberately not used here:
 * every new backend phrasing would otherwise need an allowlist entry.
 */
const CODEX_CREDENTIAL_404_MARKERS = [
  "not authorized",
  "unauthorized",
  "unauthorised",
  "invalid token",
  "invalid_token",
  "expired",
  "revoked",
] as const;

function hasCodexCredentialAuthSignal(error: InferenceErrorLike): boolean {
  return combinedTextIncludesMarker(
    [error.message ?? "", stringFromRaw(error.raw)],
    CODEX_CREDENTIAL_404_MARKERS,
  );
}

/**
 * Single shared predicate behind the Codex credential-404 re-login copy: the
 * classifier brands with it (formatCodexCredential404Message) and the
 * terminal-guidance dedup checks with it, so the two cannot drift.
 */
export function carriesCodexReLoginHint(text: string): boolean {
  return /log in again|sign in again/i.test(text);
}

/** Branded re-login line for a Codex credential 404, diagnostic appended. */
function formatCodexCredential404Message(
  profile: string,
  originalDiagnostic: string,
): string {
  const branded = `Codex profile "${profile}" is not authorized. Log in again.`;
  const oneLine = originalDiagnostic.replace(/\s+/g, " ").trim();
  if (oneLine.length === 0 || branded.includes(oneLine)) return branded;
  const clipped = oneLine.length > 200 ? `${oneLine.slice(0, 199)}…` : oneLine;
  return `${branded} (${clipped})`;
}

/**
 * Reclassification telemetry for the Codex credential-404 classifier. The
 * backend invents new 404 reasons over time; the counter plus the last-body
 * sample let future unknown-404 waves be spotted without guessing.
 */
let codexCredential404ReclassifiedCount = 0;
let lastReclassifiedCodex404Sample = "";

export function codexCredential404ReclassifiedStats(): {
  readonly count: number;
  readonly lastSample: string;
} {
  return {
    count: codexCredential404ReclassifiedCount,
    lastSample: lastReclassifiedCodex404Sample,
  };
}

export function resetCodexCredential404StatsForTests(): void {
  codexCredential404ReclassifiedCount = 0;
  lastReclassifiedCodex404Sample = "";
}

function recordCodexCredential404Reclassification(
  error: InferenceErrorLike,
): void {
  codexCredential404ReclassifiedCount += 1;
  const sample = [error.message ?? "", stringFromRaw(error.raw)]
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
  lastReclassifiedCodex404Sample =
    sample.length > 500 ? `${sample.slice(0, 499)}…` : sample;
}

/**
 * Codex answers unauthenticated requests with 426/404, so a fatal 404 in a
 * known-Codex context whose body carries an auth-rejection signal is an
 * expired, invalid, or revoked credential — not a bad model name. The
 * re-login copy matches the CodexAuthError shape so the TUI names the
 * affected profile through its existing auth matchers; the original
 * diagnostic rides along in parens so the model name stays debuggable.
 * Anything without an auth signal keeps the fatal switch-models path.
 */
function normalizeCodexCredential404Error(
  error: InferenceErrorWithGoContext,
): InferenceError {
  if (error.category !== "fatal") return error;
  if (error.statusCode !== 404) return error;
  const providerId = error.providerId;
  if (providerId === undefined || !isCodexProviderName(providerId))
    return error;
  if (!hasCodexCredentialAuthSignal(error)) return error;
  const profile = codexProfileFromProviderName(providerId) ?? providerId;
  const message = formatCodexCredential404Message(profile, error.message ?? "");
  recordCodexCredential404Reclassification(error);
  return {
    category: "credential_failure",
    message,
    statusCode: 404,
    ...(error.raw !== undefined ? { raw: error.raw } : {}),
    ...(error.retryAfterMs !== undefined
      ? { retryAfterMs: error.retryAfterMs }
      : {}),
  };
}

/**
 * Reclassify gateway overload errors so the default retry policy treats them as
 * transient instead of aborting on protocol_mismatch. Also normalizes OpenCode
 * Go quota/rate-limit shapes (including HTTP 400 mis-status), known-xAI short
 * 429s, attributable xAI capacity protocol_mismatch, Codex usage limits
 * (nested detail.error with resets_in_seconds), known-Codex short 429s that
 * are not usage_limit_reached, and known-Codex 404s carrying an
 * auth-rejection signal (expired/revoked credential).
 */
export function normalizeInferenceErrorForRetry(
  error: InferenceErrorWithGoContext,
): InferenceError {
  const goNormalized = normalizeOpenCodeGoInferenceError(error);
  if (goNormalized !== error) return goNormalized;

  const xaiNormalized = normalizeXaiRateLimitError(error);
  if (xaiNormalized !== error) return xaiNormalized;

  const xaiCapacity = normalizeXaiCapacityError(error);
  if (xaiCapacity !== error) return xaiCapacity;

  const codexNormalized = normalizeCodexUsageLimitError(error);
  if (codexNormalized !== error) return codexNormalized;

  const codexRateLimit = normalizeCodexRateLimitError(error);
  if (codexRateLimit !== error) return codexRateLimit;

  const codexCredential = normalizeCodexCredential404Error(error);
  if (codexCredential !== error) return codexCredential;

  if (!isGatewayOverloadInferenceError(error)) return error;
  if (error.category === "retryable" || error.category === "timeout")
    return error;

  return {
    category: "retryable",
    message: GATEWAY_OVERLOAD_USER_MESSAGE,
    statusCode: error.statusCode ?? 503,
    ...(error.raw !== undefined ? { raw: error.raw } : {}),
    ...(error.retryAfterMs !== undefined
      ? { retryAfterMs: error.retryAfterMs }
      : {}),
  };
}

function isInferenceErrorCategory(
  category: string,
): category is InferenceError["category"] {
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
  if (!isGatewayOverloadInferenceError(error))
    return error.message ?? "Inference error";
  return GATEWAY_OVERLOAD_USER_MESSAGE;
}
