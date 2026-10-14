import {
  mkdir,
  open,
  readFile,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// File-lock primitives shared by every credential lock in this repo. The
// invariants that make them safe: per-waiter unique claims name the holder,
// kill(pid, 0) liveness takes over a crashed holder's lock, an untagged lock
// older than the stale horizon is presumed orphaned, a steal re-reads before
// unlinking so a concurrent winner's fresh lock is never removed, and both a
// post-create content check and a fenced release keep a loser from deleting
// or releasing under a live winner.

export function isErrnoCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    err.code === code
  );
}

export function isEnoent(err: unknown): boolean {
  return isErrnoCode(err, "ENOENT");
}

// Per-waiter unique claim (pid + counter): pid alone is not unique per call,
// so the counter leg tells our claim from a concurrent winner's.
let lockClaimCounter = 0;

export function newLockClaim(): string {
  return `${String(process.pid)}:${String((lockClaimCounter += 1))}`;
}

export function holderPid(content: string): number | null {
  const pid = Number(content.split(":")[0]?.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

// kill(pid, 0) liveness: success or EPERM means alive; ESRCH/EINVAL mean
// dead. Any other failure reads as alive — never steal a live holder's lock
// on a confused signal check; the waiter times out with a recovery hint.
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !isErrnoCode(err, "ESRCH") && !isErrnoCode(err, "EINVAL");
  }
}

// Null when the lock vanished under the waiter (a release raced the read);
// anything but ENOENT propagates — permission and disk errors must surface.
export async function readLockContent(
  lockPath: string,
): Promise<string | null> {
  try {
    return await readFile(lockPath, "utf8");
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

// True when the lock is safe to take over: a tagged holder with a dead PID
// (crashed), or a legacy untagged lock older than the stale horizon. A
// vanished lock reads as not stale; the acquire loop retries the create.
export async function isLockStale(
  lockPath: string,
  staleMs: number,
  content: string,
): Promise<boolean> {
  const pid = holderPid(content);
  if (pid !== null) return !isPidAlive(pid);
  try {
    const info = await stat(lockPath);
    return Date.now() - info.mtimeMs > staleMs;
  } catch (err) {
    if (isEnoent(err)) return false;
    throw err;
  }
}

// Same-process callers queue on an in-memory tail per lock path so a backed-up
// queue stalls no longer than its own deadline.
const tails = new Map<string, Promise<void>>();

// Called when the deadline passes without acquiring the lock. Each consumer
// carries its own failure shape (message text, cause, recovery hint).
export type FileLockTimeoutError = (
  lockPath: string,
  timeoutMs: number,
  cause: unknown,
) => Error;

export interface FileLockOptions {
  /** Maximum wait for the lock before giving up. */
  timeoutMs: number;
  /** Poll interval while contending. Defaults to 25. */
  retryMs?: number;
  /**
   * Age at which an untagged holder is presumed crashed and the lock is taken
   * over. Must stay far above the longest legitimate hold and any contender
   * timeout, or a waiter steals a live holder's lock. PID-tagged locks ignore
   * this: a dead PID takes over, a live one never does.
   */
  staleMs: number;
  timeoutError: FileLockTimeoutError;
}

// Credential locks in this repo serialize on exactly this acquire/release
// pairing: exclusive-create with a holder tag, stale takeover, and a fenced
// claim-matched release. Do not fork a variant that drops any of the three.
export async function withFileLock<TResult>(
  lockPath: string,
  work: () => Promise<TResult>,
  options: FileLockOptions,
): Promise<TResult> {
  const retryMs = options.retryMs ?? 25;
  const deadline = Date.now() + options.timeoutMs;

  const previous = tails.get(lockPath) ?? Promise.resolve();
  let releaseTail!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseTail = resolve;
  });
  tails.set(lockPath, current);

  try {
    // Bound the queue wait by the same deadline as file contention.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        previous.catch(() => undefined),
        new Promise<never>((_, reject) => {
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            reject(
              options.timeoutError(lockPath, options.timeoutMs, undefined),
            );
            return;
          }
          timer = setTimeout(() => {
            reject(
              options.timeoutError(lockPath, options.timeoutMs, undefined),
            );
          }, remaining);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }

    const claim = newLockClaim();
    let lock: FileHandle | undefined;

    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
    for (;;) {
      try {
        const handle = await open(lockPath, "wx", 0o600);
        try {
          await handle.writeFile(claim, "utf8");
        } catch (writeError) {
          await closeQuietly(handle);
          // A half-written lock would read as an untakeable claim; remove it
          // and surface the original failure.
          try {
            await unlink(lockPath);
          } catch (unlinkError) {
            if (!isEnoent(unlinkError)) throw unlinkError;
          }
          throw writeError;
        }
        // A steal may have replaced our fresh file between create and write;
        // the path then names a live winner. Close and re-contend — never
        // unlink.
        if ((await readLockContent(lockPath)) !== claim) {
          await closeQuietly(handle);
          await pace(options, lockPath, retryMs, deadline, undefined);
          continue;
        }
        lock = handle;
        break;
      } catch (error) {
        if (!isErrnoCode(error, "EEXIST")) throw error;
        // A crashed holder never releases: take over a stale lock rather
        // than keep waiting. A lock that vanished under the read is not
        // stale — retry the exclusive create.
        const content = await readLockContent(lockPath);
        if (
          content !== null &&
          (await isLockStale(lockPath, options.staleMs, content))
        ) {
          // Re-check before unlinking so a concurrent winner's fresh claim
          // is never mistaken for the stale entry just observed — claims
          // are unique per waiter. A steal can still interleave between
          // re-read and unlink; the post-create check above detects the
          // loser and re-contends.
          if ((await readLockContent(lockPath)) === content) {
            try {
              await unlink(lockPath);
            } catch (unlinkError) {
              if (!isEnoent(unlinkError)) throw unlinkError;
            }
          }
        }
        // Fall through to the deadline/sleep path: a steal that lost to a
        // concurrent winner paces like any other contention.
        await pace(options, lockPath, retryMs, deadline, error);
      }
    }

    const releaseClaim = async (): Promise<void> => {
      if (lock === undefined) return;
      try {
        await lock.close();
      } catch {
        // The work outcome owns precedence; a close failure must not mask it.
      }
      try {
        // Fenced release: remove the file only while it still carries our
        // claim, or a stale-takeover steal would hand two holders grants.
        if ((await readLockContent(lockPath)) === claim) {
          await unlink(lockPath);
        }
      } catch (error) {
        // A steal racing the release removes the file first — that is a
        // normal outcome; anything else surfaces after the work value.
        if (!isEnoent(error)) throw error;
      }
    };

    let workOutcome:
      | { ok: true; value: TResult }
      | { ok: false; error: unknown };
    try {
      workOutcome = { ok: true, value: await work() };
    } catch (error) {
      workOutcome = { ok: false, error };
    }
    let releaseOutcome: { ok: true } | { ok: false; error: unknown } = {
      ok: true,
    };
    try {
      await releaseClaim();
    } catch (error) {
      releaseOutcome = { ok: false, error };
    }
    if (!workOutcome.ok) throw workOutcome.error;
    if (!releaseOutcome.ok) throw releaseOutcome.error;
    return workOutcome.value;
  } finally {
    if (tails.get(lockPath) === current) tails.delete(lockPath);
    releaseTail();
  }
}

async function pace(
  options: FileLockOptions,
  lockPath: string,
  retryMs: number,
  deadline: number,
  cause: unknown,
): Promise<void> {
  if (Date.now() >= deadline)
    throw options.timeoutError(lockPath, options.timeoutMs, cause);
  await delay(retryMs);
}

async function closeQuietly(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    // Close failures never mask the contended state of the lock file.
  }
}
