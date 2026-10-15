import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type } from "arktype";
import type { AuthProfile, BaseTokens } from "@corbits/oauth-core";
import { isErrnoCode, withFileLock } from "./file-lock.js";

export type { AuthProfile, BaseTokens };

// On-disk store for named OAuth profiles. A user may hold multiple
// subscriptions for one provider, so credentials are keyed by a user-chosen
// profile name in a single file. File is owner-only (0o600), directory 0o700,
// writes go temp-file + rename, and same-process writers queue per auth path.

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
  // Remove one profile, or all when `name` is undefined; returns the names removed.
  removeProfile: (name: string | undefined, home?: string) => Promise<string[]>;
}

export interface AuthStoreOptions<TTokens extends BaseTokens> {
  // Filename under the injected settings directory (e.g. "codex-auth.json").
  filename: string;
  settingsDirName: string;
  isTokens: (value: unknown) => value is TTokens;
  /** Override the credential-lock wait; tests pass a short window to skip the production 1s. */
  lockTimeoutMs?: number;
}

interface AuthFile<TTokens extends BaseTokens> {
  profiles: Record<string, AuthProfile<TTokens>>;
}

const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 1_000;

// Age at which a lock file with no holder PID (a foreign writer, or one
// predating PID tagging) is presumed orphaned and taken over. Far above
// LOCK_TIMEOUT_MS so a waiter never declares a live holder stale mid-wait.
const LOCK_STALE_MS = 5_000;

// Per-call unique temp (pid + counter); pid alone is not unique if
// writeAuthFile ever overlaps in-process.
let tmpWriteCounter = 0;

// Same-process ops on one auth file queue here so a caller's lock deadline
// starts when it runs, not when it was invoked — one held-past-timeout lock
// then fails only its first waiter, not the whole burst.
const updateChains = new Map<string, Promise<unknown>>();

const AuthFileShape = type({
  profiles: "Record<string, unknown>",
});

const ProfileShape = type({
  name: "string",
  createdAt: "number",
  tokens: "unknown",
});

function isProfile<TTokens extends BaseTokens>(
  value: unknown,
  isTokens: (value: unknown) => value is TTokens,
): value is AuthProfile<TTokens> {
  const parsed = ProfileShape(value);
  if (parsed instanceof type.errors) return false;
  return isTokens(parsed.tokens);
}

function lockTimeoutError(lockPath: string, cause: unknown): Error {
  return new Error(
    `Timed out waiting for OAuth credential lock ${lockPath}. ` +
      "If no Corbits process is running, remove this lock file manually and retry.",
    { cause },
  );
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
      // Drop invalid entries rather than wedge the session on one corrupt
      // profile; a fresh login overwrites it.
      const valid: Record<string, AuthProfile<TTokens>> = {};
      for (const [name, entry] of Object.entries(parsed.profiles)) {
        if (isProfile(entry, options.isTokens)) valid[name] = entry;
      }
      return { profiles: valid };
    } catch (err) {
      // A corrupt file is not fatal; treat it as no state. Re-throw
      // non-SyntaxError (validator bugs etc.).
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
    const lockPath = `${authPath(home)}.lock`;
    return withFileLock(lockPath, callback, {
      timeoutMs: options.lockTimeoutMs ?? LOCK_TIMEOUT_MS,
      retryMs: LOCK_RETRY_MS,
      staleMs: LOCK_STALE_MS,
      timeoutError: (lockPath, _timeoutMs, cause) =>
        lockTimeoutError(lockPath, cause),
    });
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
    // The return is the value observed under the lock: this update, a
    // concurrent winner, or undefined after removal.
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
