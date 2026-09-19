import { mkdir, open, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

// Serializes Codex OAuth refresh-and-persist sections across processes that
// share one credential store (concurrent headless runs). Same-process
// callers chain on an in-memory tail; cross-process callers contend on an
// exclusive lock file. At most one refresh grant is ever in flight, so a
// second refresher observes the persisted result instead of racing the
// authorization server's refresh-token rotation and revoking its sibling.
const tails = new Map<string, Promise<void>>();

// Default stale horizon: crashed-holder recovery only. Kept far above any
// legitimate hold and any contender timeout so a live holder is never
// declared stale mid-wait (see the staleMs field docs).
const DEFAULT_STALE_MS = 120_000;

export interface CodexRefreshLockOptions {
  /** Maximum wait for the lock before giving up. Defaults to 30_000. */
  timeoutMs?: number;
  /** Poll interval while contending. Defaults to 25. */
  retryMs?: number;
  /**
   * Lock-file age at which the holder is presumed crashed and the lock is
   * taken over. Defaults to 120_000. This must stay far above the longest
   * legitimate hold (the token endpoint timeout plus store I/O) — and, in
   * particular, far above any contender's own timeout — otherwise a waiter
   * declares the live holder stale mid-wait, steals the lock, and the two
   * overlapping refresh grants revoke each other under token rotation.
   */
  staleMs?: number;
}

// The lock could not be acquired in time: either a refresh is genuinely
// stalled past the timeout, or a crashed holder's lock survived takeover.
// Carries the lock path so the message can tell the operator how to recover.
export class CodexRefreshLockTimeoutError extends Error {
  readonly lockPath: string;

  constructor(lockPath: string, timeoutMs: number) {
    super(
      `Timed out after ${String(timeoutMs)}ms waiting for the Codex refresh lock ` +
        `at ${lockPath}. If no refresh is running, remove this lock file manually and retry.`,
    );
    this.name = "CodexRefreshLockTimeoutError";
    this.lockPath = lockPath;
  }
}

async function acquireLockFile(
  lockPath: string,
  timeoutMs: number,
  retryMs: number,
  staleMs: number,
): Promise<void> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const start = Date.now();
  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.close();
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
    }
    try {
      // A crashed holder never releases: once its lock is older than the
      // stale horizon, unlink and take over rather than brick refreshes.
      const info = await stat(lockPath);
      if (Date.now() - info.mtimeMs > staleMs) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
    } catch {
      // The lock vanished (or was never stat-able) between attempts: loop
      // around and contend for it again.
    }
    if (Date.now() - start >= timeoutMs)
      throw new CodexRefreshLockTimeoutError(lockPath, timeoutMs);
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
}

/**
 * Runs `work` while holding the refresh lock at `lockPath`. Concurrent
 * same-process callers queue in memory; concurrent processes queue on the
 * lock file. The lock file is always removed afterwards.
 */
export async function withCodexRefreshLock<T>(
  lockPath: string,
  work: () => Promise<T>,
  options: CodexRefreshLockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const retryMs = options.retryMs ?? 25;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const previous = tails.get(lockPath) ?? Promise.resolve();
  let releaseTail!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseTail = resolve;
  });
  tails.set(lockPath, current);
  try {
    await previous.catch(() => undefined);
    await acquireLockFile(lockPath, timeoutMs, retryMs, staleMs);
    try {
      return await work();
    } finally {
      await unlink(lockPath).catch(() => undefined);
    }
  } finally {
    if (tails.get(lockPath) === current) tails.delete(lockPath);
    releaseTail();
  }
}
