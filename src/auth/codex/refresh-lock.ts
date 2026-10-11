import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

// Serializes Codex OAuth refresh-and-persist sections across processes that
// share one credential store. Same-process callers chain on an in-memory
// tail; cross-process callers contend on an exclusive lock file with
// crashed-holder takeover via PID liveness; the inner TokenSession dedups
// overlapping refreshes. At most one refresh grant is in flight, so a second
// refresher sees the persisted result instead of racing refresh-token
// rotation and revoking its sibling.
//
// Accepted limits: PID liveness only means something on one host in one PID
// namespace (ESRCH would steal a live holder's lock, a recycled PID stalls
// recovery), and one lock path per store (two spellings contend on two
// files). Same-host headless runs satisfy both.
const tails = new Map<string, Promise<void>>();

// Stale horizon for legacy locks that carry no holder PID (foreign writers,
// pre-tagging locks). Kept far above any legitimate hold and contender
// timeout so a live holder is never declared stale mid-wait.
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

// Holder tag: the creating PID (for crashed-holder liveness) plus a unique
// token, so only the creator removes the file — a belated release after a
// stale-takeover steal would otherwise hand two holders overlapping grants.
function holderTag(): string {
  return `${String(process.pid)}:${randomUUID()}`;
}

function holderPid(content: string): number | null {
  const pid = Number(content.split(":")[0]?.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

// kill(pid, 0) liveness: EPERM is alive (other user), ESRCH/EINVAL dead,
// anything else treated as alive so a confused signal check never steals a
// live holder's lock. Only meaningful within one PID namespace.
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code !== "ESRCH" && code !== "EINVAL";
  }
}

async function readLockContent(lockPath: string): Promise<string | null> {
  try {
    return await readFile(lockPath, "utf8");
  } catch {
    return null;
  }
}

// Safe to take over: a tagged holder with a dead PID, or an untagged lock
// older than the stale horizon.
async function isLockStale(
  lockPath: string,
  staleMs: number,
  content: string | null,
): Promise<boolean> {
  if (content === null) return false;
  const pid = holderPid(content);
  if (pid !== null) return !isPidAlive(pid);
  try {
    const info = await stat(lockPath);
    return Date.now() - info.mtimeMs > staleMs;
  } catch {
    // The lock vanished between read and stat: not ours to take over.
    return false;
  }
}

async function acquireLockFile(
  lockPath: string,
  timeoutMs: number,
  retryMs: number,
  staleMs: number,
  deadline: number,
): Promise<string> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  for (;;) {
    const tag = holderTag();
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(tag, "utf8");
      await handle.close();
      return tag;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
    }
    // A crashed holder never releases: unlink and take over. Re-check the
    // content first so a concurrent winner's fresh lock is not unlinked.
    const content = await readLockContent(lockPath);
    if (content !== null && (await isLockStale(lockPath, staleMs, content))) {
      if ((await readLockContent(lockPath)) === content) {
        await unlink(lockPath).catch(() => undefined);
      }
      continue;
    }
    if (Date.now() >= deadline)
      throw new CodexRefreshLockTimeoutError(lockPath, timeoutMs);
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
}

// Bound the in-memory queue wait by the same deadline as file contention,
// or a backed-up queue stalls far longer than timeoutMs promises.
async function waitForTail(
  previous: Promise<void>,
  lockPath: string,
  timeoutMs: number,
  deadline: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      previous.catch(() => undefined),
      new Promise<never>((_, reject) => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          reject(new CodexRefreshLockTimeoutError(lockPath, timeoutMs));
          return;
        }
        timer = setTimeout(() => {
          reject(new CodexRefreshLockTimeoutError(lockPath, timeoutMs));
        }, remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs `work` while holding the refresh lock at `lockPath`. Same-process
 * callers queue in memory, other processes on the lock file; one deadline
 * covers both, so the call holds or throws within ~timeoutMs. The creating
 * holder removes the file. Callers must pass one canonical path per store.
 */
export async function withCodexRefreshLock<T>(
  lockPath: string,
  work: () => Promise<T>,
  options: CodexRefreshLockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const retryMs = options.retryMs ?? 25;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const deadline = Date.now() + timeoutMs;
  const previous = tails.get(lockPath) ?? Promise.resolve();
  let releaseTail!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseTail = resolve;
  });
  tails.set(lockPath, current);
  try {
    await waitForTail(previous, lockPath, timeoutMs, deadline);
    const tag = await acquireLockFile(
      lockPath,
      timeoutMs,
      retryMs,
      staleMs,
      deadline,
    );
    try {
      return await work();
    } finally {
      // Fenced release: remove the file only while it still carries our
      // tag, or a stale-takeover steal would hand two holders grants.
      if ((await readLockContent(lockPath)) === tag) {
        await unlink(lockPath).catch(() => undefined);
      }
    }
  } finally {
    if (tails.get(lockPath) === current) tails.delete(lockPath);
    releaseTail();
  }
}
