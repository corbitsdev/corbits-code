import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SETTINGS_DIR_NAME } from "../../branding.js";

// On-disk store for named OAuth profiles. A user may hold multiple subscriptions
// for the same provider, so credentials are keyed by a user-chosen profile name
// within a single file. Tokens are credentials, so the file is owner-only (0o600)
// and the directory 0o700. Writes go through a temp file + rename so a concurrent
// reader never observes a torn file.

export interface BaseTokens {
  access: string;
  refresh: string;
  expiresAt: number;
}

export interface AuthProfile<TTokens extends BaseTokens> {
  name: string;
  tokens: TTokens;
  // Epoch milliseconds the profile was first authorized; informational.
  createdAt: number;
}

export interface AuthStore<TTokens extends BaseTokens> {
  authPath: (home?: string) => string;
  listProfiles: (home?: string) => Promise<AuthProfile<TTokens>[]>;
  loadProfile: (name: string, home?: string) => Promise<AuthProfile<TTokens> | undefined>;
  saveProfile: (profile: AuthProfile<TTokens>, home?: string) => Promise<void>;
  updateTokens: (name: string, tokens: TTokens, home?: string) => Promise<void>;
  // Remove one profile, or all profiles when `name` is undefined. Returns the
  // names removed.
  removeProfile: (name: string | undefined, home?: string) => Promise<string[]>;
}

export interface AuthStoreOptions<TTokens extends BaseTokens> {
  // Filename under ~/.corbits/ (e.g. "codex-auth.json").
  filename: string;
  isTokens: (value: unknown) => value is TTokens;
}

interface AuthFile<TTokens extends BaseTokens> {
  profiles: Record<string, AuthProfile<TTokens>>;
}

function isProfile<TTokens extends BaseTokens>(
  value: unknown,
  isTokens: (value: unknown) => value is TTokens,
): value is AuthProfile<TTokens> {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return typeof p.name === "string" && typeof p.createdAt === "number" && isTokens(p.tokens);
}

export function createAuthStore<TTokens extends BaseTokens>(
  options: AuthStoreOptions<TTokens>,
): AuthStore<TTokens> {
  const authPath = (home: string = homedir()): string =>
    join(home, SETTINGS_DIR_NAME, options.filename);

  async function readAuthFile(home: string): Promise<AuthFile<TTokens>> {
    let raw: string;
    try {
      raw = await readFile(authPath(home), "utf8");
    } catch (err) {
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code?: unknown }).code === "ENOENT"
      ) {
        return { profiles: {} };
      }
      throw err;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === "object" && parsed !== null && "profiles" in parsed) {
        const profiles = (parsed as { profiles: unknown }).profiles;
        if (typeof profiles === "object" && profiles !== null) {
          // Drop any entry that fails validation rather than wedging the session
          // on a single corrupt profile; a fresh login overwrites it.
          const valid: Record<string, AuthProfile<TTokens>> = {};
          for (const [name, entry] of Object.entries(profiles)) {
            if (isProfile(entry, options.isTokens)) valid[name] = entry;
          }
          return { profiles: valid };
        }
      }
    } catch (err) {
      // A corrupt file should not be fatal; treat it as no state.
      // Re-throw unexpected errors (TypeError from a bug in the validator
      // etc.) that are not JSON parse failures.
      if (!(err instanceof SyntaxError)) throw err;
    }
    return { profiles: {} };
  }

  async function writeAuthFile(file: AuthFile<TTokens>, home: string): Promise<void> {
    const path = authPath(home);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    await rename(tmp, path);
  }

  // Exclusive file lock serialises read-modify-write operations so concurrent
  // CLI sessions cannot clobber each other's profiles or fresher tokens.
  const LOCK_RETRY_MS = 50;
  const LOCK_TIMEOUT_MS = 15_000;
  const STALE_LOCK_MS = 10_000;

  function lockPath(home: string): string {
    return `${authPath(home)}.lock`;
  }

  async function withStoreLock<T>(home: string, fn: () => Promise<T>): Promise<T> {
    const path = lockPath(home);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;

    while (true) {
      let fd: Awaited<ReturnType<typeof open>> | undefined;
      try {
        fd = await open(path, "wx");
        await fd.close();
        break;
      } catch (err) {
        if (fd !== undefined) await fd.close().catch(() => {});

        if (
          typeof err === "object" &&
          err !== null &&
          "code" in err &&
          (err as { code?: unknown }).code === "EEXIST"
        ) {
          // Another process holds the lock; check for a stale lock.
          try {
            const info = await stat(path);
            if (Date.now() - info.mtimeMs > STALE_LOCK_MS) {
              await unlink(path).catch(() => {});
              continue;
            }
          } catch {
            // Lock vanished between the failed create and the stat — retry.
          }

          if (Date.now() >= deadline) {
            throw new Error(`Timed out acquiring store lock: ${path}`);
          }

          await new Promise<void>((r) => setTimeout(r, LOCK_RETRY_MS));
          continue;
        }
        throw err;
      }
    }

    try {
      return await fn();
    } finally {
      await unlink(path).catch(() => {});
    }
  }

  return {
    authPath,
    async listProfiles(home: string = homedir()): Promise<AuthProfile<TTokens>[]> {
      const file = await readAuthFile(home);
      return Object.values(file.profiles).sort((a, b) => a.name.localeCompare(b.name));
    },
    async loadProfile(
      name: string,
      home: string = homedir(),
    ): Promise<AuthProfile<TTokens> | undefined> {
      const file = await readAuthFile(home);
      return file.profiles[name];
    },
    async saveProfile(profile: AuthProfile<TTokens>, home: string = homedir()): Promise<void> {
      return withStoreLock(home, async () => {
        const file = await readAuthFile(home);
        file.profiles[profile.name] = profile;
        await writeAuthFile(file, home);
      });
    },
    // Persist refreshed tokens for an existing profile, preserving createdAt. A
    // no-op if the profile no longer exists (e.g. removed in another session).
    async updateTokens(name: string, tokens: TTokens, home: string = homedir()): Promise<void> {
      return withStoreLock(home, async () => {
        const file = await readAuthFile(home);
        const existing = file.profiles[name];
        if (existing === undefined) return;
        file.profiles[name] = { ...existing, tokens };
        await writeAuthFile(file, home);
      });
    },
    async removeProfile(name: string | undefined, home: string = homedir()): Promise<string[]> {
      return withStoreLock(home, async () => {
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
