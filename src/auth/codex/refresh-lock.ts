import { withFileLock } from "../file-lock.js";

// Serializes Codex OAuth refresh-and-persist sections across processes that
// share one credential store. Same-process callers chain on an in-memory
// tail; cross-process callers contend on an exclusive lock file with a
// crashed-holder takeover via PID liveness. At most one refresh grant is in
// flight, so a second refresher sees the persisted result instead of racing
// refresh-token rotation and revoking its sibling.
//
// Accepted limits: PID liveness only means something on one host in one PID
// namespace (ESRCH would steal a live holder's lock, a recycled PID stalls
// recovery), and one lock path per store (two spellings contend on two
// files). Same-host headless runs satisfy both.

// Stale horizon for legacy locks that carry no holder PID (foreign writers,
// pre-tagging locks). Kept far above any legitimate hold and contender
// timeout so a live holder is never declared stale mid-wait. The provider
// auth store's own lock horizon is deliberately smaller (5s, short auth-file
// mutations); these two horizons are pinned invariants and must not unify.
const DEFAULT_STALE_MS = 120_000;

export interface CodexRefreshLockOptions {
  /** Maximum wait for the lock before giving up. Defaults to 30_000. */
  timeoutMs?: number;
  /** Poll interval while contending. Defaults to 25. */
  retryMs?: number;
  /**
   * Age at which an untagged holder is presumed crashed and the lock is
   * taken over. Defaults to 120_000. Must stay far above the longest
   * legitimate hold and any contender timeout, or a waiter steals a live
   * holder's lock and the overlapping grants revoke each other under token
   * rotation. PID-tagged locks ignore this: dead PID takes over, live PID
   * never does.
   */
  staleMs?: number;
}

// The lock could not be acquired in time — a stalled refresh, or a crashed
// holder's lock surviving takeover. Carries the lock path for recovery.
export class CodexRefreshLockTimeoutError extends Error {
  readonly lockPath: string;
  readonly timeoutMs: number;

  constructor(lockPath: string, timeoutMs: number) {
    super(
      `Timed out after ${String(timeoutMs)}ms waiting for the Codex refresh lock ` +
        `at ${lockPath}. If no refresh is running, remove this lock file manually and retry.`,
    );
    this.name = "CodexRefreshLockTimeoutError";
    this.lockPath = lockPath;
    this.timeoutMs = timeoutMs;
  }
}

export async function withCodexRefreshLock<T>(
  lockPath: string,
  work: () => Promise<T>,
  options: CodexRefreshLockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  return withFileLock(lockPath, work, {
    timeoutMs,
    retryMs: options.retryMs ?? 25,
    staleMs: options.staleMs ?? DEFAULT_STALE_MS,
    timeoutError: (lockPath: string, timeoutMs: number) =>
      new CodexRefreshLockTimeoutError(lockPath, timeoutMs),
  });
}
