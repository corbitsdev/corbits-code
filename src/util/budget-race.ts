// Shared timeout-race primitives: race a promise against an AbortSignal-driven
// wall-clock budget. Used by both the shell-guard search budget and the
// tool-execution watchdog, which otherwise reimplemented the same race twice.

export const BUDGET_EXPIRED = Symbol("budget-expired");

/** Resolves with BUDGET_EXPIRED once `signal` aborts (immediately if already aborted). */
export function budgetExpiry(signal: AbortSignal): Promise<typeof BUDGET_EXPIRED> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(BUDGET_EXPIRED);
      return;
    }
    signal.addEventListener("abort", () => resolve(BUDGET_EXPIRED), { once: true });
  });
}

/** Derives a signal that aborts when `signal` aborts or after `timeoutMs`, whichever first. */
export function withTimeout(
  signal: AbortSignal,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  signal.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal.aborted) controller.abort();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onParentAbort);
    },
  };
}
