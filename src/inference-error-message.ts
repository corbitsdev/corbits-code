/**
 * Transcript-facing text for a classified inference failure: one line saying
 * what happened and whether the operator can act on it.
 */

import { formatCodexUsageLimitMessage } from "./auth/codex/usage-limit-error.js";
import {
  codexProfileFromProviderName,
  isCodexProviderName,
} from "./config/codex-providers.js";
import { stripTerminalControlSequences } from "./util/control-char-strip.js";
import { scrubSecretShapedContent } from "./plugins/tool-result-secret-scrub.js";
import {
  carriesCodexReLoginHint,
  gatewayOverloadUserMessage,
  isCodexShortRateLimitInferenceError,
  isGatewayOverloadInferenceError,
  isKnownOAuthProviderId,
  isXaiShortRateLimitInferenceError,
  normalizeInferenceErrorForTerminal,
  parseCodexUsageLimitFromError,
  RATE_LIMIT_USER_MESSAGE,
  type InferenceErrorLike,
} from "./inference-gateway-error.js";

/** Committed auth death — do not claim a refresh is in flight. */
export const CREDENTIAL_FAILURE_USER_MESSAGE =
  "Authentication failed — run /connect to reconnect the provider profile.";

const FRIENDLY_BY_CATEGORY: Record<string, string> = {
  credential_failure: CREDENTIAL_FAILURE_USER_MESSAGE,
  quota_exhausted: "Quota exhausted — usage limit reached.",
  context_overflow:
    "Context window full — compaction could not keep up. Try /clear to start fresh.",
  retryable: "Request failed — will retry.",
  aborted: "Request aborted.",
  timeout: "Request timed out.",
  protocol_mismatch: "Unexpected response from inference API.",
};

/**
 * Provider-agnostic context-window-overflow detection. The upstream classifier
 * only tags 400s with specific phrases; 429s and differently-worded bodies
 * slip through mislabeled, so the message is re-checked here.
 */
export function looksLikeContextOverflow(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("context_length_exceeded") ||
    lower.includes("context length") ||
    lower.includes("context window") ||
    lower.includes("maximum context") ||
    lower.includes("too many tokens") ||
    lower.includes("input is too long") ||
    lower.includes("exceeds the maximum") ||
    lower.includes("reduce the length")
  );
}

/** Category the error should be treated as, trusting message text over a mislabel. */
export function classifyInferenceErrorCategory(
  error: InferenceErrorLike,
): string {
  return looksLikeContextOverflow(error.message ?? "")
    ? "context_overflow"
    : error.category;
}

/**
 * Whether a normalized provider-failure category is transient enough that a
 * parent may spawn one successor with the same brief. Allowlist:
 * retryable/timeout — including 429 overload, which normalizes to retryable.
 * Fatal categories win explicitly: credential, quota, and context-overflow
 * failures must never read as continuable.
 */
const FATAL_PROVIDER_FAILURE_CATEGORIES: ReadonlySet<string> = new Set([
  "credential_failure",
  "quota_exhausted",
  "context_overflow",
]);

const RECOVERABLE_PROVIDER_FAILURE_CATEGORIES: ReadonlySet<string> = new Set([
  "retryable",
  "timeout",
]);

export function isRecoverableProviderFailureCategory(
  category: string,
): boolean {
  if (FATAL_PROVIDER_FAILURE_CATEGORIES.has(category)) return false;
  return RECOVERABLE_PROVIDER_FAILURE_CATEGORIES.has(category);
}

function codexUsageLimitLine(error: InferenceErrorLike): string | undefined {
  // Match normalizeCodexUsageLimitError: never brand a known non-Codex source.
  if (
    error.providerId !== undefined &&
    !isCodexProviderName(error.providerId)
  ) {
    return undefined;
  }

  // Already-normalized path: message is our formatted line.
  if (
    typeof error.message === "string" &&
    /codex .*usage limit reached/i.test(error.message) &&
    error.message.includes("/model")
  ) {
    return error.message;
  }

  // Candidate-list-plus-parse scan shared with the gateway-error module.
  const parsed = parseCodexUsageLimitFromError(error);
  if (parsed === undefined) return undefined;
  const profile =
    error.providerId !== undefined
      ? codexProfileFromProviderName(error.providerId)
      : undefined;
  return formatCodexUsageLimitMessage(parsed, {
    ...(profile !== undefined ? { profile } : {}),
  });
}

const TERMINAL_PROVIDER_LABEL_MAX_CHARS = 80;

function safeDisplayText(text: string, maxChars?: number): string {
  const oneLine = scrubSecretShapedContent(stripTerminalControlSequences(text))
    .replace(/\s+/g, " ")
    .trim();
  return maxChars !== undefined && oneLine.length > maxChars
    ? `${oneLine.slice(0, maxChars - 1)}…`
    : oneLine;
}

function terminalProviderFailureCategory(error: InferenceErrorLike): string {
  const category = classifyInferenceErrorCategory(error);
  return /^[a-z][a-z0-9_]*$/i.test(category) ? category : "unknown";
}

/** Sanitize the display label: trim, scrub, clamp, drop a trailing "Provider". */
function terminalProviderFailureLabel(
  providerId: string,
  displayLabel?: string,
): string {
  const preferred = displayLabel?.trim() || providerId;
  const sanitizedLabel = safeDisplayText(
    preferred,
    TERMINAL_PROVIDER_LABEL_MAX_CHARS,
  );
  return (sanitizedLabel.length > 0 ? sanitizedLabel : "Unknown").replace(
    /\s+Provider$/i,
    "",
  );
}

export function terminalProviderFailureMessage(
  providerId: string,
  error: InferenceErrorLike,
  displayLabel?: string,
): string {
  const label = terminalProviderFailureLabel(providerId, displayLabel);
  const category = terminalProviderFailureCategory(error);
  const message = safeDisplayText(error.message ?? "");
  const diagnostic = message.length > 0 ? message : "inference error";
  const diagnosticSentence = /[.!?]$/.test(diagnostic)
    ? diagnostic
    : `${diagnostic}.`;
  const guidance = terminalProviderFailureGuidance(error, category, providerId);
  const tail = guidance.length > 0 ? ` ${guidance}` : "";
  return `${label} Provider failed (${category}): ${diagnosticSentence}${tail}`;
}

/**
 * Split a `kind/name` provider id into its reconnect scope. Unslashed ids
 * reconnect the `default` profile; malformed ids return undefined so the
 * guidance never spells a broken command.
 */
export function splitReconnectScope(
  providerId: string,
): { kind: string; profile: string } | undefined {
  const slash = providerId.indexOf("/");
  if (slash <= 0) {
    return providerId.length > 0
      ? { kind: providerId, profile: "default" }
      : undefined;
  }
  const kind = providerId.slice(0, slash);
  const profile = providerId.slice(slash + 1);
  if (kind.length === 0 || profile.length === 0) return undefined;
  return { kind, profile };
}

/**
 * One-action reconnect command for reconnect-class failures: `Run "/connect
 * <kind> <profile>" to reconnect profile "<profile>".` Empty outside
 * credential_failure on a known-OAuth id, and when the diagnostic already
 * carries the command — never a stutter.
 */
function reconnectCommandGuidance(
  providerId: string,
  diagnosticMessage: string,
): string {
  if (!isKnownOAuthProviderId(providerId)) return "";
  const scope = splitReconnectScope(providerId);
  if (scope === undefined) return "";
  const command = `"/connect ${scope.kind} ${scope.profile}"`;
  if (diagnosticMessage.includes(command)) return "";
  return `Run ${command} to reconnect profile "${scope.profile}".`;
}

function terminalProviderFailureGuidance(
  error: InferenceErrorLike,
  category: string,
  providerId: string,
): string {
  if (category === "credential_failure") {
    // Normalized credential failures already carry the re-login hint;
    // repeating it reads as a stutter (one shared predicate).
    const base = carriesCodexReLoginHint(error.message ?? "")
      ? ""
      : CREDENTIAL_FAILURE_USER_MESSAGE;
    // Reconnect-class failures spell the explicit command so the operator can
    // repair the named profile in one action; the Codex line keeps its wording.
    const explicit = reconnectCommandGuidance(
      error.providerId ?? providerId,
      error.message ?? "",
    );
    if (explicit.length === 0) return base;
    return base.length > 0 ? `${base} ${explicit}` : explicit;
  }
  if (category === "context_overflow") return "Try /clear to start fresh.";
  // A 429 that survived paced retries is a wait-it-out rate limit, not a flake.
  if (category === "retryable" && error.statusCode === 429) {
    return "Wait a moment and try again.";
  }
  if (
    category === "retryable" ||
    (error.statusCode !== undefined &&
      error.statusCode >= 500 &&
      error.statusCode <= 599)
  ) {
    return "Try again.";
  }
  return category === "protocol_mismatch"
    ? 'Switch models with "/model".'
    : 'Try again or switch models with "/model".';
}

export type ResolvedProviderFailureError = Error & {
  readonly name: "ResolvedProviderFailureError";
  readonly providerId: string;
  readonly category: string;
  readonly statusCode?: number;
};

export function createResolvedProviderFailureError(
  providerId: string,
  providerError: InferenceErrorLike,
  displayLabel?: string,
): ResolvedProviderFailureError {
  const normalized = normalizeInferenceErrorForTerminal(
    providerError,
    providerId,
  );
  return Object.assign(
    new Error(
      terminalProviderFailureMessage(providerId, normalized, displayLabel),
    ),
    {
      name: "ResolvedProviderFailureError" as const,
      providerId,
      category: terminalProviderFailureCategory(normalized),
      ...(normalized.statusCode !== undefined
        ? { statusCode: normalized.statusCode }
        : {}),
    },
  );
}

export function isResolvedProviderFailureError(
  error: unknown,
): error is ResolvedProviderFailureError {
  return (
    error instanceof Error &&
    error.name === "ResolvedProviderFailureError" &&
    "providerId" in error &&
    typeof error.providerId === "string" &&
    "category" in error &&
    typeof error.category === "string"
  );
}

/** One line describing the failure, falling back to the provider's own message. */
export function inferenceErrorMessage(error: InferenceErrorLike): string {
  if (isGatewayOverloadInferenceError(error))
    return gatewayOverloadUserMessage(error);
  // The harness may still emit quota_exhausted for a known-xAI / known-Codex
  // short 429; FRIENDLY_BY_CATEGORY would otherwise say "Quota exhausted".
  if (
    isXaiShortRateLimitInferenceError(error) ||
    isCodexShortRateLimitInferenceError(error)
  )
    return RATE_LIMIT_USER_MESSAGE;

  const category = classifyInferenceErrorCategory(error);
  if (category === "quota_exhausted") {
    const codexLine = codexUsageLimitLine(error);
    if (codexLine !== undefined) return codexLine;
  }

  const fallback = safeDisplayText(error.message ?? "");
  return (
    FRIENDLY_BY_CATEGORY[category] ??
    (fallback.length > 0 ? fallback : "inference error")
  );
}
