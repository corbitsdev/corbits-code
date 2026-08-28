/**
 * Transcript-facing text for a classified inference failure.
 *
 * The raw provider body behind a failed call is a JSON blob with a stack of
 * gateway framing around it; what the operator needs is one line saying what
 * happened and whether they can do anything about it.
 */

import {
  formatCodexUsageLimitMessage,
  parseCodexUsageLimitError,
} from "./auth/codex/usage-limit-error.js";
import { codexProfileFromProviderName, isCodexProviderName } from "./config/codex-providers.js";
import {
  gatewayOverloadUserMessage,
  isCodexShortRateLimitInferenceError,
  isGatewayOverloadInferenceError,
  isXaiShortRateLimitInferenceError,
  XAI_RATE_LIMIT_USER_MESSAGE,
  type InferenceErrorLike,
} from "./inference-gateway-error.js";

const FRIENDLY_BY_CATEGORY: Record<string, string> = {
  // Committed auth death — do not claim a refresh is in flight.
  credential_failure: "Authentication failed — log in again.",
  quota_exhausted: "Quota exhausted — usage limit reached.",
  context_overflow:
    "Context window full — compaction could not keep up. Try /clear to start fresh.",
  retryable: "Request failed — will retry.",
  aborted: "Request aborted.",
  timeout: "Request timed out.",
  protocol_mismatch: "Unexpected response from inference API.",
};

/**
 * Provider-agnostic detection of context-window-overflow error text. The
 * upstream classifier only tags a 400 with specific English phrases as
 * context_overflow; providers that return a 429 or a differently-worded body
 * (e.g. z.ai) slip through mislabeled, so the message is re-checked here.
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
export function classifyInferenceErrorCategory(error: InferenceErrorLike): string {
  return looksLikeContextOverflow(error.message ?? "") ? "context_overflow" : error.category;
}

function codexUsageLimitLine(error: InferenceErrorLike): string | undefined {
  // Match normalizeCodexUsageLimitError: never brand a known non-Codex source.
  if (error.providerId !== undefined && !isCodexProviderName(error.providerId)) {
    return undefined;
  }

  const candidates: unknown[] = [];
  if (error.raw !== undefined) candidates.push(error.raw);
  if (typeof error.message === "string" && error.message.trim().startsWith("{")) {
    candidates.push(error.message);
  }
  // Already-normalized path: message is our formatted line.
  if (
    typeof error.message === "string" &&
    /codex .*usage limit reached/i.test(error.message) &&
    error.message.includes("/model")
  ) {
    return error.message;
  }

  for (const candidate of candidates) {
    const parsed = parseCodexUsageLimitError(candidate);
    if (parsed === undefined) continue;
    const profile =
      error.providerId !== undefined ? codexProfileFromProviderName(error.providerId) : undefined;
    return formatCodexUsageLimitMessage(parsed, {
      ...(profile !== undefined ? { profile } : {}),
    });
  }
  return undefined;
}

/** One line describing the failure, falling back to the provider's own message. */
export function inferenceErrorMessage(error: InferenceErrorLike): string {
  if (isGatewayOverloadInferenceError(error)) return gatewayOverloadUserMessage(error);
  // Dual-path: harness may still emit intx's quota_exhausted for a known-xAI
  // or known-Codex short 429; FRIENDLY_BY_CATEGORY would otherwise say
  // "Quota exhausted".
  if (isXaiShortRateLimitInferenceError(error)) return XAI_RATE_LIMIT_USER_MESSAGE;
  if (isCodexShortRateLimitInferenceError(error)) return XAI_RATE_LIMIT_USER_MESSAGE;

  const category = classifyInferenceErrorCategory(error);
  if (category === "quota_exhausted") {
    const codexLine = codexUsageLimitLine(error);
    if (codexLine !== undefined) return codexLine;
  }

  return FRIENDLY_BY_CATEGORY[category] ?? error.message ?? "inference error";
}
