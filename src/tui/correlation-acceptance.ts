/**
 * Occupancy wait for a fire-and-forget Agent.deliver of a correlated
 * approval. The reactor accepts the resume asynchronously after deliver
 * returns; inFlight must not drop until that acceptance (or an uncorrelated
 * pass-through / identity bump) settles the waiter.
 */

export function createCorrelationAcceptance() {
  const waiters = new Map<string, () => void>();

  const settle = (correlationId: string): void => {
    const resolve = waiters.get(correlationId);
    if (resolve === undefined) return;
    waiters.delete(correlationId);
    resolve();
  };

  return {
    wait(correlationId: string): Promise<void> {
      const pending = waiters.get(correlationId);
      return new Promise<void>((resolve) => {
        waiters.set(correlationId, () => {
          pending?.();
          resolve();
        });
      });
    },
    settle,
    settleAll(): void {
      for (const correlationId of [...waiters.keys()]) settle(correlationId);
    },
  };
}
