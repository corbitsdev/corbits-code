import { createDefaultRetryPolicy } from "@intx/inference";
import type { RetryDecision, RetryPolicy, RetrySituation } from "@intx/types/runtime";
import {
  normalizeInferenceErrorForRetry,
  type InferenceErrorWithGoContext,
} from "../inference-gateway-error.js";

// Providers that enforce long-window quotas (e.g. monthly limits) set
// Retry-After to days or weeks. The default policy trusts that value and
// schedules the next attempt accordingly — silently blocking the session
// for the full duration. Abort instead and surface the error immediately
// so the user can switch providers or decide when to retry manually.
const MAX_BLIND_WAIT_MS = 30_000;

export interface CorbitsRetryPolicyOptions {
  /**
   * Catalog provider id (e.g. xai/thegreataxios) stamped onto errors before
   * normalize. Pass a getter when the live provider can change mid-session
   * (e.g. `/model`); it is resolved on each retry decision.
   */
  providerId?: string | (() => string | undefined);
}

/**
 * Corbits retry policy. When `providerId` is set, merges it onto the error
 * before `normalizeInferenceErrorForRetry` so known-provider remappers (xAI
 * short 429 → retryable, Go, Codex) can gate on context the harness does not
 * attach to InferenceError today.
 */
export function createCorbitsRetryPolicy(options?: CorbitsRetryPolicyOptions): RetryPolicy {
  const defaultPolicy = createDefaultRetryPolicy();
  return (situation: RetrySituation): RetryDecision | Promise<RetryDecision> => {
    const raw = options?.providerId;
    const stampedProviderId = typeof raw === "function" ? raw() : raw;
    const incoming = situation.error as InferenceErrorWithGoContext;
    const withProvider: InferenceErrorWithGoContext =
      stampedProviderId !== undefined && incoming.providerId === undefined
        ? { ...incoming, providerId: stampedProviderId }
        : incoming;
    const error = normalizeInferenceErrorForRetry(withProvider);
    if (
      error.category === "quota_exhausted" &&
      error.retryAfterMs !== undefined &&
      error.retryAfterMs > MAX_BLIND_WAIT_MS
    ) {
      return { kind: "abort" };
    }
    return defaultPolicy({ ...situation, error });
  };
}
