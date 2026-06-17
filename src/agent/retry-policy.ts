import { createDefaultRetryPolicy } from "@intx/inference";
import type { RetryDecision, RetryPolicy, RetrySituation } from "@intx/types/runtime";

// Providers that enforce long-window quotas (e.g. monthly limits) set
// Retry-After to days or weeks. The default policy trusts that value and
// schedules the next attempt accordingly — silently blocking the session
// for the full duration. Abort instead and surface the error immediately
// so the user can switch providers or decide when to retry manually.
const MAX_BLIND_WAIT_MS = 30_000;

export function createIntercodeRetryPolicy(): RetryPolicy {
  const defaultPolicy = createDefaultRetryPolicy();
  return (situation: RetrySituation): RetryDecision | Promise<RetryDecision> => {
    const { error } = situation;
    if (
      error.category === "quota_exhausted" &&
      error.retryAfterMs !== undefined &&
      error.retryAfterMs > MAX_BLIND_WAIT_MS
    ) {
      return { kind: "abort" };
    }
    return defaultPolicy(situation);
  };
}
