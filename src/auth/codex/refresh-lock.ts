import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

// Serializes Codex OAuth refresh-and-persist sections across processes that
// share one credential store (concurrent headless runs). Three layers:
// (1) same-process callers chain on an in-memory tail so they never contend
// on the file with each other; (2) cross-process callers contend on an
// exclusive lock file, with crashed-holder takeover via PID liveness;
// (3) inside the lock, the inner TokenSession dedups overlapping refreshes
// for one credential store. At most one refresh grant is ever in flight, so
// a second refresher observes the persisted result instead of racing the
// authorization server's refresh-token rotation and revoking its sibling.
const tails = new Map<string, Promise<void>>();

// Default stale horizon for legacy lock files that carry no holder PID
// (foreign writers, or locks predating PID tagging): crashed-holder recovery
// only. Kept far above any legitimate hold and any contender timeout so a
// live holder is never declared stale mid-wait (see the staleMs field docs).
const DEFAULT_STALE_MS = 120_000;

export interface CodexRefreshLockOptions {
  /** Maximum wait for the lock before giving up. Defaults to 30_000. */
  timeoutMs?: number;
  /** Poll interval while contending. Defaults to 25. */
  retryMs?: number;
  /**
   * Lock-file age at which an untagged (PID-less) holder is presumed crashed
   * and the lock is taken over. Defaults to 120_000. This must stay far
   * above the longest legitimate hold (the token endpoint timeout plus store
   * I/O) — and, in particular, far above any contender's own timeout —
   * otherwise a waiter declares the live holder stale mid-wait, steals the
   * lock, and the two overlapping refresh grants revoke each other under
   * token rotation. PID-tagged locks ignore this horizon: a dead PID takes
   * over immediately, a live PID never does.
   */
  staleMs?: number;
}

// The lock could not be acquired in time: either a refresh is genuinely
// stalled past the timeout, or a crashed holder's lock survived takeover.
// Carries the lock path so the message can tell the operator how to recover.
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

// Holder tag written into the lock file on creation: the creating PID (for
// crashed-holder liveness) plus a unique token (so only the creator removes
// it — a stale-takeover steal is never deleted by the victim's belated
// release, which would otherwise hand two holders overlapping grants).
function holderTag(): string {
  return `${String(process.pid)}:${randomUUID()}`;
}

function holderPid(content: string): number | null {
  const pid = Number(content.split(":")[0]?.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

// kill(pid, 0) liveness: success means the process exists (alive); EPERM
// means it exists but belongs to another user (alive); ESRCH/EINVAL mean no
// such process (dead). Any other failure is treated as alive — never steal
// a live holder's lock on a confused signal check; the waiter times out with
// a recovery hint instead.
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

// True when the observed lock is safe to take over: a tagged holder whose
// PID is dead (crashed — reachable under any timeout/stale combination), or
// a legacy untagged lock older than the stale horizon.
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
    // A crashed holder never releases: unlink and take over rather than
    // brick refreshes. The content is re-checked before unlinking so a
    // concurrent takeover winner's fresh lock is never mistaken for the
    // stale entry just observed.
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

// Same-process queueing never waits past the acquisition deadline: without
// this bound the in-memory tail sits outside the file timer and a backed-up
// queue stalls far longer than timeoutMs promises.
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
 * Runs `work` while holding the refresh lock at `lockPath`. Concurrent
 * same-process callers queue in memory; concurrent processes queue on the
 * lock file. The lock file is removed afterwards by the holder that created
 * it. One acquisition deadline covers both the queue wait and the file
 * contention, so the call either holds the lock or throws within ~timeoutMs.
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
      // Fenced release: only remove the file while it still carries our tag.
      // A stale-takeover steal replaces the content; deleting it would hand
      // two holders overlapping grants.
      if ((await readLockContent(lockPath)) === tag) {
        await unlink(lockPath).catch(() => undefined);
      }
    }
  } finally {
    if (tails.get(lockPath) === current) tails.delete(lockPath);
    releaseTail();
  }
}
