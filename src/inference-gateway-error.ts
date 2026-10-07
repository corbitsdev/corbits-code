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
  readCodexNestedErrorMessage,
} from "./auth/codex/usage-limit-error.js";
import {
  codexProfileFromProviderName,
  isCodexProviderName,
} from "./config/codex-providers.js";
import {
  isXaiProviderName,
  xaiProfileFromProviderName,
} from "./config/xai-providers.js";
import { isXaiGrokLeafProvider } from "./subagent/provider-family.js";

export interface InferenceErrorLike {
  category: string;
  message?: string;
  statusCode?: number;
  raw?: unknown;
  retryAfterMs?: number;
  /** Optional request base/url when known — used to scope Go error reclassification. */
  requestURL?: string;
  /** Provider catalog id when known (e.g. opencode-go, codex/acme-labs). */
  providerId?: string;
  /** Explicit OpenCode Go provider flag when known. */
  opencodeGo?: boolean;
}

/** Optional Go context so bare 429s reclassify without body markers. */
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

/** User-visible line for a short known-provider 429; also terminal once retries are exhausted. */
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

/** Substring check over joined, lowercased parts; shared by the three detectors. */
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
 * HTML-bodied 503 / reverse-proxy overload that upstream classifies as
 * protocol_mismatch when the stream body is not valid SSE/JSON.
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
 * Known OpenCode Go errors: provider context (id / flag / request URL) or Go
 * body markers. Bare `provider_rate_limit_exceeded` alone is not enough;
 * other proxies use it.
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
 * Reclassify Go quota / rate-limit / auth failures when the request is known
 * Go or the body carries Go error types. A bare 429 in a known-Go context
 * becomes retryable rate_limit, not long-window quota.
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

/** User-visible line for an attributable xAI / Grok capacity error; also terminal once retries are exhausted. */
export const XAI_CAPACITY_USER_MESSAGE = "xAI at capacity";

/**
 * xAI / Grok capacity phrases arriving as protocol_mismatch. "Service
 * temporarily unavailable" matches exactly, never substring (would rematch
 * quota copy).
 */
const XAI_CAPACITY_TEXT_MARKERS = [
  "currently at capacity",
  "overloaded",
  "high demand",
] as const;

const XAI_CAPACITY_EXACT_MESSAGES = new Set([
  "service temporarily unavailable",
]);

/** Exact-match only — never substring. Checks the part itself and common JSON message fields. */
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
 * Unknown providers stay terminal; quota markers anywhere veto the remap.
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
 * provider's 429 (quota_exhausted or remapped retryable) with no usage-limit
 * markers. Provider identity and the veto differ per provider; check order
 * is fixed.
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
 * Known-xAI 429 that is a short rate limit, not a usage/quota window;
 * FRIENDLY_BY_CATEGORY would otherwise paint every quota_exhausted 429 as
 * "Quota exhausted". Discrimination is quota body markers, not Retry-After
 * length.
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
 * Shared skeleton behind the twin rate-limit normalizers: non-429s, non-quota
 * categories, unknown providers, and usage-limit bodies pass through; a bare
 * 429 becomes retryable with scrubbed copy.
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
 * Bare 429 (or rate-limit body without usage/quota markers) in a known-xAI /
 * Grok context reclassifies as retryable; intx defaults bare 429 to
 * quota_exhausted, and clear usage/quota markers keep it.
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
 * Known-Codex 429 that is a short rate limit, not a `usage_limit_reached`
 * window; FRIENDLY_BY_CATEGORY would otherwise paint every quota_exhausted
 * 429 as "Quota exhausted". Discrimination is the Codex usage-limit parser,
 * not Retry-After length or bare prose.
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
 * Bare 429 (or usage-limit prose without `usage_limit_reached`) in a
 * known-Codex context reclassifies as retryable; intx defaults bare 429 to
 * quota_exhausted, and nested `usage_limit_reached` keeps it.
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
 * Lift Codex `usage_limit_reached` bodies onto quota_exhausted with a reset
 * ETA and profile-switch hint; the nested diagnostic stays on `raw`. Known
 * non-Codex sources keep their own quota copy.
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
 * Auth-rejection signals for the Codex credential-404 classifier: a
 * known-Codex fatal 404 reclassifies ONLY when the message or raw body
 * carries one; bare / routing 404s stay fatal. No negative matching — new
 * backend phrasing would otherwise need an allowlist entry per phrase.
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
 * Model-deprecation signals that veto the credential-404 classifier. A
 * retired-model 404 can itself carry "expired" ("model 'gpt-4o' has expired —
 * migrate to 'gpt-5'"); reclassifying would send the operator to log in again
 * for a model that no longer exists. The veto needs a model mention plus a
 * deprecation signal.
 */
const CODEX_MODEL_DEPRECATION_MARKERS = [
  "model_expired",
  "model_deprecated",
  "deprecated",
  "deprecation",
  "retired",
  "sunset",
  "no longer supported",
  "no longer available",
  "has expired",
  "end of life",
] as const;

function looksLikeCodexModelDeprecation(error: InferenceErrorLike): boolean {
  const combined = [error.message ?? "", stringFromRaw(error.raw)]
    .join("\n")
    .toLowerCase();
  if (!combined.includes("model")) return false;
  return CODEX_MODEL_DEPRECATION_MARKERS.some((marker) =>
    combined.includes(marker),
  );
}

/**
 * Shared predicate behind the Codex credential-404 re-login copy: the
 * classifier brands with it and the terminal-guidance dedup checks with it,
 * so the two cannot drift.
 */
export function carriesCodexReLoginHint(text: string): boolean {
  return /\/connect/i.test(text) && /codex profile/i.test(text);
}

/** Branded re-login line for a Codex credential 404, diagnostic appended. */
function formatCodexCredential404Message(
  profile: string,
  originalDiagnostic: string,
): string {
  const branded = `Codex profile "${profile}" is not authorized. Run /connect, choose Codex, and reconnect profile "${profile}".`;
  const oneLine = originalDiagnostic.replace(/\s+/g, " ").trim();
  if (oneLine.length === 0 || branded.includes(oneLine)) return branded;
  const clipped = oneLine.length > 200 ? `${oneLine.slice(0, 199)}…` : oneLine;
  return `${branded} (${clipped})`;
}

/**
 * A known-Codex fatal 404 whose body carries an auth-rejection signal is an
 * expired/revoked credential, not a bad model name; reclassify to
 * credential_failure with re-login copy. No auth signal keeps the fatal
 * switch-models path, as does a model-deprecation 404 even with the word
 * "expired".
 */
function normalizeCodexCredential404Error(
  error: InferenceErrorWithGoContext,
): InferenceError {
  if (error.category !== "fatal") return error;
  if (error.statusCode !== 404) return error;
  const providerId = error.providerId;
  if (providerId === undefined || !isCodexProviderName(providerId))
    return error;
  // Deprecation veto runs before the auth markers so a retired model wins
  // over a merely expired-sounding word.
  if (looksLikeCodexModelDeprecation(error)) return error;
  if (!hasCodexCredentialAuthSignal(error)) return error;
  const profile = codexProfileFromProviderName(providerId) ?? providerId;
  const message = formatCodexCredential404Message(profile, error.message ?? "");
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
 * Fatal 400s arrive with statusText ("Bad Request") while the real diagnostic
 * sits on nested `detail.error` / `error.message`; lift it so the transcript
 * is actionable. Category stays fatal; Codex and xAI/Grok both do this.
 */
function normalizeFatal400NestedMessage(
  error: InferenceErrorWithGoContext,
): InferenceError {
  if (error.category !== "fatal") return error;
  if (error.statusCode !== 400) return error;
  const providerId = error.providerId;
  if (
    !isKnownCodexProviderId(providerId) &&
    !isKnownXaiProviderId(providerId)
  ) {
    return error;
  }

  const current = error.message ?? "";
  if (current.length > 0 && current.toLowerCase() !== "bad request") {
    return error;
  }

  const nested = readCodexNestedErrorMessage(error.raw);
  if (nested === undefined || nested === current) return error;

  return {
    category: "fatal",
    message: nested,
    statusCode: 400,
    ...(error.raw !== undefined ? { raw: error.raw } : {}),
    ...(error.retryAfterMs !== undefined
      ? { retryAfterMs: error.retryAfterMs }
      : {}),
  };
}

/**
 * OAuth provider ids eligible for upgrade-class reconnect: known-xAI /
 * Grok-leaf and known-Codex ids. Shared with the transcript guidance and the
 * reconnect descriptor so all three agree on the set.
 */
export function isKnownOAuthProviderId(
  providerId: string | undefined,
): providerId is string {
  if (providerId === undefined || providerId.length === 0) return false;
  if (isCodexProviderName(providerId)) return true;
  return isKnownXaiProviderId(providerId);
}

/**
 * Upgrade/auth-rejection signals for the OAuth 426 classifier: the 426 reason
 * phrase plus the auth-rejection phrasing shared with the Codex
 * credential-404 markers. A 426 on an OAuth profile means the request arrived
 * unauthenticated.
 */
const OAUTH_UPGRADE_426_MARKERS = [
  "upgrade",
  "unauthenticated",
  "unauthorized",
  "unauthorised",
  "invalid token",
  "invalid_token",
  "expired",
  "revoked",
  "reconnect",
  "reauthenticate",
  "re-authenticate",
] as const;

function hasOAuthUpgrade426Signal(error: InferenceErrorLike): boolean {
  return combinedTextIncludesMarker(
    [error.message ?? "", stringFromRaw(error.raw)],
    OAUTH_UPGRADE_426_MARKERS,
  );
}

/** Deprecation phrasing that vetoes the 426 classifier; same rationale as the Codex model-deprecation veto. */
const OAUTH_UPGRADE_426_DEPRECATION_MARKERS = [
  "deprecated",
  "deprecation",
  "retired",
  "sunset",
  "end of life",
  "no longer supported",
  "no longer available",
  "migrate",
] as const;

function looksLikeOAuthUpgrade426Deprecation(
  error: InferenceErrorLike,
): boolean {
  return combinedTextIncludesMarker(
    [error.message ?? "", stringFromRaw(error.raw)],
    OAUTH_UPGRADE_426_DEPRECATION_MARKERS,
  );
}

/**
 * Branded re-auth line for a non-Codex OAuth 426, mirroring
 * formatCodexCredential404Message; an empty diagnostic leaves the branded
 * line standing alone.
 */
function formatOAuthUpgrade426Message(
  kindLabel: string,
  chooseClause: string,
  profile: string,
  originalDiagnostic: string,
): string {
  const branded = `${kindLabel} profile "${profile}" needs re-authentication. Run /connect${chooseClause} and reconnect profile "${profile}".`;
  const oneLine = originalDiagnostic.replace(/\s+/g, " ").trim();
  if (oneLine.length === 0 || branded.includes(oneLine)) return branded;
  const clipped = oneLine.length > 200 ? `${oneLine.slice(0, 199)}…` : oneLine;
  return `${branded} (${clipped})`;
}

/**
 * OAuth 426 is an unauthenticated-provider rejection, not a bad model name: a
 * fatal 426 on a known-OAuth id becomes credential_failure so the transcript
 * can offer a reconnect. Quota and deprecation markers veto. No body-signal
 * requirement — the reported xAI 426 arrives bare, so status-426 on an OAuth
 * id is sufficient. Recognized phrasing is echoed in the branded line;
 * unrecognized server copy stays on `raw`.
 */
function normalizeOAuthUpgradeRequiredError(
  error: InferenceErrorWithGoContext,
): InferenceError {
  if (error.category !== "fatal") return error;
  if (error.statusCode !== 426) return error;
  const providerId = error.providerId;
  if (!isKnownOAuthProviderId(providerId)) return error;
  if (looksLikeOAuthUpgrade426Deprecation(error)) return error;
  if (textHasXaiQuotaMarkers(error.message ?? "", stringFromRaw(error.raw))) {
    return error;
  }
  const recognized = hasOAuthUpgrade426Signal(error);
  const diagnostic = recognized ? (error.message ?? "") : "";
  const profile =
    codexProfileFromProviderName(providerId) ??
    xaiProfileFromProviderName(providerId) ??
    (providerId.split("/").slice(1).join("/") || providerId);
  const message = isCodexProviderName(providerId)
    ? formatCodexCredential404Message(profile, diagnostic)
    : providerId.split("/")[0] === "xai"
      ? formatOAuthUpgrade426Message(
          "xAI",
          ", choose xAI,",
          profile,
          diagnostic,
        )
      : formatOAuthUpgrade426Message(
          providerId.split("/")[0] ?? providerId,
          "",
          profile,
          diagnostic,
        );
  return {
    category: "credential_failure",
    message,
    statusCode: 426,
    ...(error.raw !== undefined ? { raw: error.raw } : {}),
    ...(error.retryAfterMs !== undefined
      ? { retryAfterMs: error.retryAfterMs }
      : {}),
  };
}

/**
 * Run every known-provider normalizer in fixed order: OpenCode Go shapes,
 * known-xAI / known-Codex short 429s and capacity/usage-limit bodies, Codex
 * credential 404s, fatal 400s with nested diagnostics, OAuth 426s, gateway
 * overload. First match wins; unchanged errors pass through.
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

  const fatal400 = normalizeFatal400NestedMessage(error);
  if (fatal400 !== error) return fatal400;

  const oauthUpgrade = normalizeOAuthUpgradeRequiredError(error);
  if (oauthUpgrade !== error) return oauthUpgrade;

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
