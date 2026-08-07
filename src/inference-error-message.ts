/**
 * Transcript-facing text for a classified inference failure.
 *
 * The raw provider body behind a failed call is a JSON blob with a stack of
 * gateway framing around it; what the operator needs is one line saying what
 * happened and whether they can do anything about it.
 */

import {
  gatewayOverloadUserMessage,
  isGatewayOverloadInferenceError,
  type InferenceErrorLike,
} from "./inference-gateway-error.js";

const FRIENDLY_BY_CATEGORY: Record<string, string> = {
  // Re-authentication runs on its own; keep the transcript line short and free
  // of the provider's raw 401 JSON.
  credential_failure: "Session expired — re-authenticating…",
  quota_exhausted: "Quota exhausted — usage limit reached.",
  context_overflow: "Context window full — compaction could not keep up. Try /clear to start fresh.",
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

/** One line describing the failure, falling back to the provider's own message. */
export function inferenceErrorMessage(error: InferenceErrorLike): string {
  if (isGatewayOverloadInferenceError(error)) return gatewayOverloadUserMessage(error);
  return FRIENDLY_BY_CATEGORY[classifyInferenceErrorCategory(error)] ?? error.message ?? "inference error";
}
