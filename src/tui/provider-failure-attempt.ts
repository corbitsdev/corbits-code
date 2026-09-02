import type { InferenceErrorLike } from "../inference-gateway-error.js";

export interface ProviderFailureAttempt {
  observed: boolean;
  presented: boolean;
  error: InferenceErrorLike | undefined;
  providerId?: string;
  displayLabel?: string;
}

const presentationSuppressedEvents = new WeakSet<object>();

export function suppressProviderFailurePresentation<T extends object>(event: T): T {
  presentationSuppressedEvents.add(event);
  return event;
}

export function isProviderFailurePresentationSuppressed(event: object): boolean {
  return presentationSuppressedEvents.has(event);
}

export function createProviderFailureAttemptTracker() {
  const attempts: ProviderFailureAttempt[] = [];
  const settledSends = new Set<ProviderFailureAttempt>();
  const consumedTerminals = new Set<ProviderFailureAttempt>();

  const remove = (attempt: ProviderFailureAttempt): void => {
    const index = attempts.indexOf(attempt);
    if (index !== -1) attempts.splice(index, 1);
    settledSends.delete(attempt);
    consumedTerminals.delete(attempt);
  };

  return {
    begin(identity?: { providerId: string; displayLabel?: string }): ProviderFailureAttempt {
      const attempt = {
        observed: false,
        presented: false,
        error: undefined,
        ...(identity !== undefined ? identity : {}),
      };
      attempts.push(attempt);
      return attempt;
    },
    current(): ProviderFailureAttempt | undefined {
      return attempts[0];
    },
    reset(): void {
      const active = attempts[0];
      if (active === undefined) return;
      active.observed = false;
      active.presented = false;
      active.error = undefined;
    },
    observe(error: InferenceErrorLike): void {
      const active = attempts[0];
      if (active === undefined) return;
      active.observed = true;
      active.error = error;
    },
    markPresented(attempt: ProviderFailureAttempt): void {
      attempt.presented = true;
    },
    consumeConnectorReply():
      { attempt: ProviderFailureAttempt; suppressPresentation: boolean } | undefined {
      const active = attempts[0];
      if (active === undefined) return undefined;
      const suppressPresentation = active.presented;
      if (active.observed) active.presented = true;
      return { attempt: active, suppressPresentation };
    },
    consumeTerminal(): void {
      const active = attempts[0];
      if (active === undefined) return;
      consumedTerminals.add(active);
      if (settledSends.has(active)) remove(active);
    },
    sendSettled(attempt: ProviderFailureAttempt): void {
      settledSends.add(attempt);
      if (consumedTerminals.has(attempt)) remove(attempt);
    },
    advanceToNextMessage(): void {
      const active = attempts[0];
      if (attempts.length > 1 && active !== undefined && settledSends.has(active)) remove(active);
    },
    settle(attempt: ProviderFailureAttempt): void {
      remove(attempt);
    },
  };
}
