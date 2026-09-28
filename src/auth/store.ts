import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type } from "arktype";
import type { AuthProfile, BaseTokens } from "@corbits/oauth-core";

export type { AuthProfile, BaseTokens };

// On-disk store for named OAuth profiles. A user may hold multiple subscriptions
// for the same provider, so credentials are keyed by a user-chosen profile name
// within a single file. Tokens are credentials, so the file is owner-only (0o600)
// and the directory 0o700. Writes go through a temp file + rename so a concurrent
// reader never observes a torn file. Same-process writers also queue per auth path
// so each lock wait starts its own deadline.

export interface AuthStore<TTokens extends BaseTokens> {
  authPath: (home?: string) => string;
  listProfiles: (home?: string) => Promise<AuthProfile<TTokens>[]>;
  loadProfile: (
    name: string,
    home?: string,
  ) => Promise<AuthProfile<TTokens> | undefined>;
  saveProfile: (profile: AuthProfile<TTokens>, home?: string) => Promise<void>;
  updateTokens: (
    name: string,
    tokens: TTokens,
    home?: string,
    expectedRefreshToken?: string,
  ) => Promise<AuthProfile<TTokens> | undefined>;
  // Remove one profile, or all profiles when `name` is undefined. Returns the
  // names removed.
  removeProfile: (name: string | undefined, home?: string) => Promise<string[]>;
}

export interface AuthStoreOptions<TTokens extends BaseTokens> {
  // Filename under the injected settings directory (e.g. "codex-auth.json").
  filename: string;
  settingsDirName: string;
  isTokens: (value: unknown) => value is TTokens;
  /**
   * Override the credential-lock wait. Tests pass a short window so they do
   * not pay the production 1s in wall clock; production never sets it and
   * keeps the default.
   */
  lockTimeoutMs?: number;
}

interface AuthFile<TTokens extends BaseTokens> {
  profiles: Record<string, AuthProfile<TTokens>>;
}

const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 1_000;

// Age at which a lock file carrying no holder PID (a foreign writer, or a
// lock predating PID tagging) is presumed orphaned by a crashed holder and
// taken over. Stays far above LOCK_TIMEOUT_MS so a waiter never declares a
// live holder stale mid-wait; PID-tagged locks ignore this horizon.
const LOCK_STALE_MS = 5_000;

// Per-call unique temp (pid + counter). Matches mcp/auth-store — pid alone is not
// unique per call if writeAuthFile ever overlaps in-process.
let tmpWriteCounter = 0;

// Same-process ops on one auth file queue here so a caller's lock deadline
// starts when it actually runs, not when it was invoked — otherwise one lock
// held past LOCK_TIMEOUT_MS fails the whole burst, not just the first waiter.
const updateChains = new Map<string, Promise<unknown>>();

const AuthFileShape = type({
  profiles: "Record<string, unknown>",
});

const ProfileShape = type({
  name: "string",
  createdAt: "number",
  tokens: "unknown",
});

function isErrnoCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    err.code === code
  );
}

function isProfile<TTokens extends BaseTokens>(
  value: unknown,
  isTokens: (value: unknown) => value is TTokens,
): value is AuthProfile<TTokens> {
  const parsed = ProfileShape(value);
  if (parsed instanceof type.errors) return false;
  return isTokens(parsed.tokens);
}

function holderPid(content: string): number | null {
  const pid = Number(content.split(":")[0]?.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

// kill(pid, 0) liveness: success means the process exists (alive); EPERM
// means it exists but belongs to another user (alive); ESRCH/EINVAL mean no
// such process (dead). Any other failure reads as alive — never steal a live
// holder's lock on a confused signal check; the waiter times out with a
// recovery hint instead.
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code !== "ESRCH" && code !== "EINVAL";
  }
}

// Null when the lock vanished under the waiter (a release raced the read);
// anything but ENOENT propagates — permission and disk errors must surface,
// not read as an empty lock.
async function readLockContent(lockPath: string): Promise<string | null> {
  try {
    return await readFile(lockPath, "utf8");
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return null;
    throw err;
  }
}

// True when the observed lock is safe to take over: a tagged holder whose
// PID is dead (crashed — reachable under any timeout), or a legacy untagged
// lock older than the stale horizon. A vanished lock reads as not stale;
// the acquire loop retries the exclusive create instead.
async function isLockStale(
  lockPath: string,
  content: string,
): Promise<boolean> {
  const pid = holderPid(content);
  if (pid !== null) return !isPidAlive(pid);
  try {
    const info = await stat(lockPath);
    return Date.now() - info.mtimeMs > LOCK_STALE_MS;
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return false;
    throw err;
  }
}

export function createAuthStore<TTokens extends BaseTokens>(
  options: AuthStoreOptions<TTokens>,
): AuthStore<TTokens> {
  const authPath = (home: string = homedir()): string =>
    join(home, options.settingsDirName, options.filename);

  async function readAuthFile(home: string): Promise<AuthFile<TTokens>> {
    let raw: string;
    try {
      raw = await readFile(authPath(home), "utf8");
    } catch (err) {
      if (isErrnoCode(err, "ENOENT")) return { profiles: {} };
      throw err;
    }
    try {
      const parsed = AuthFileShape(JSON.parse(raw));
      if (parsed instanceof type.errors) return { profiles: {} };
      // Drop any entry that fails validation rather than wedging the session
      // on a single corrupt profile; a fresh login overwrites it.
      const valid: Record<string, AuthProfile<TTokens>> = {};
      for (const [name, entry] of Object.entries(parsed.profiles)) {
        if (isProfile(entry, options.isTokens)) valid[name] = entry;
      }
      return { profiles: valid };
    } catch (err) {
      // A corrupt file should not be fatal; treat it as no state.
      // Re-throw unexpected errors (TypeError from a bug in the validator
      // etc.) that are not JSON parse failures.
      if (!(err instanceof SyntaxError)) throw err;
    }
    return { profiles: {} };
  }

  async function writeAuthFile(
    file: AuthFile<TTokens>,
    home: string,
  ): Promise<void> {
    const path = authPath(home);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.${(tmpWriteCounter += 1)}.tmp`;
    await writeFile(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    await rename(tmp, path);
  }

  async function withAuthFileLock<TResult>(
    home: string,
    callback: () => Promise<TResult>,
  ): Promise<TResult> {
    const path = authPath(home);
    const lockPath = `${path}.lock`;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + (options.lockTimeoutMs ?? LOCK_TIMEOUT_MS);
    let lock;

    while (true) {
      try {
        const handle = await open(lockPath, "wx", 0o600);
        try {
          await handle.writeFile(`${process.pid}`, "utf8");
        } catch (writeError) {
          try {
            await handle.close();
          } catch {
            // Ignore close errors on the cleanup path; the write error below
            // is the one the caller must see.
          }
          try {
            await unlink(lockPath);
          } catch (unlinkError) {
            if (!isErrnoCode(unlinkError, "ENOENT")) throw unlinkError;
          }
          throw writeError;
        }
        lock = handle;
        break;
      } catch (error) {
        if (!isErrnoCode(error, "EEXIST")) throw error;
        // A crashed holder never releases: take over a stale lock rather
        // than brick the store. A lock that vanished under the read
        // (a release raced us) is not stale — retry the exclusive create.
        const content = await readLockContent(lockPath);
        if (content !== null && (await isLockStale(lockPath, content))) {
          // Re-check before unlinking so a concurrent takeover winner's
          // fresh lock is never mistaken for the stale entry just observed.
          if ((await readLockContent(lockPath)) === content) {
            try {
              await unlink(lockPath);
            } catch (unlinkError) {
              // A concurrent winner unlinked first; retry the create.
              if (!isErrnoCode(unlinkError, "ENOENT")) throw unlinkError;
            }
          }
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `Timed out waiting for OAuth credential lock ${lockPath}. ` +
              "If no Corbits process is running, remove this lock file manually and retry.",
            { cause: error },
          );
        }
        await delay(LOCK_RETRY_MS);
      }
    }

    try {
      return await callback();
    } finally {
      try {
        await lock.close();
      } catch {
        // The callback's result (or error) owns this return path; a close
        // failure must not mask it. The unlink below still runs.
      } finally {
        // Swallow ENOENT only: a stale-takeover steal legitimately removes
        // the file first, but permission and disk errors must surface.
        try {
          await unlink(lockPath);
        } catch (error) {
          if (!isErrnoCode(error, "ENOENT")) throw error;
        }
      }
    }
  }

  function enqueueAuthFileOp<TResult>(
    home: string,
    op: () => Promise<TResult>,
  ): Promise<TResult> {
    const path = authPath(home);
    const previous = updateChains.get(path) ?? Promise.resolve();
    const run = previous.then(
      () => withAuthFileLock(home, op),
      () => withAuthFileLock(home, op),
    );
    updateChains.set(
      path,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  return {
    authPath,
    async listProfiles(
      home: string = homedir(),
    ): Promise<AuthProfile<TTokens>[]> {
      const file = await readAuthFile(home);
      return Object.values(file.profiles).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
    },
    async loadProfile(
      name: string,
      home: string = homedir(),
    ): Promise<AuthProfile<TTokens> | undefined> {
      const file = await readAuthFile(home);
      return file.profiles[name];
    },
    async saveProfile(
      profile: AuthProfile<TTokens>,
      home: string = homedir(),
    ): Promise<void> {
      await enqueueAuthFileOp(home, async () => {
        const file = await readAuthFile(home);
        file.profiles[profile.name] = profile;
        await writeAuthFile(file, home);
      });
    },
    // Persist refreshed tokens for an existing profile, preserving createdAt.
    // The returned profile is the authoritative value observed under the lock:
    // either this update, a concurrent winner, or undefined after removal.
    async updateTokens(
      name: string,
      tokens: TTokens,
      home: string = homedir(),
      expectedRefreshToken?: string,
    ): Promise<AuthProfile<TTokens> | undefined> {
      return enqueueAuthFileOp(home, async () => {
        const file = await readAuthFile(home);
        const existing = file.profiles[name];
        if (existing === undefined) return undefined;
        if (
          expectedRefreshToken !== undefined &&
          existing.tokens.refresh !== expectedRefreshToken
        )
          return existing;
        const updated = { ...existing, tokens };
        file.profiles[name] = updated;
        await writeAuthFile(file, home);
        return updated;
      });
    },
    async removeProfile(
      name: string | undefined,
      home: string = homedir(),
    ): Promise<string[]> {
      return enqueueAuthFileOp(home, async () => {
        const file = await readAuthFile(home);
        if (name === undefined) {
          const removed = Object.keys(file.profiles);
          await writeAuthFile({ profiles: {} }, home);
          return removed;
        }
        if (file.profiles[name] === undefined) return [];
        Reflect.deleteProperty(file.profiles, name);
        await writeAuthFile(file, home);
        return [name];
      });
    },
  };
}
