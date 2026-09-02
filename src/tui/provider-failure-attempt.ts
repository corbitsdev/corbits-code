import type { InferenceErrorLike } from "../inference-gateway-error.js";

export interface ProviderFailureAttempt {
  observed: boolean;
  error: InferenceErrorLike | undefined;
}

export function createProviderFailureAttemptTracker() {
  let active: ProviderFailureAttempt | undefined;

  return {
    begin(): ProviderFailureAttempt {
      const attempt = { observed: false, error: undefined };
      active = attempt;
      return attempt;
    },
    reset(): void {
      if (active === undefined) return;
      active.observed = false;
      active.error = undefined;
    },
    observe(error: InferenceErrorLike): void {
      if (active === undefined) return;
      active.observed = true;
      active.error = error;
    },
    settle(attempt: ProviderFailureAttempt): void {
      if (active === attempt) active = undefined;
    },
  };
}
