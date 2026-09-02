import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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

const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 1_000;

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

  async function withAuthFileLock<TResult>(
    home: string,
    callback: () => Promise<TResult>,
  ): Promise<TResult> {
    const path = authPath(home);
    const lockPath = `${path}.lock`;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    let lock;

    while (true) {
      try {
        lock = await open(lockPath, "wx", 0o600);
        break;
      } catch (error) {
        const isLocked =
          typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
        if (!isLocked) throw error;
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
      } finally {
        await unlink(lockPath);
      }
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
      await withAuthFileLock(home, async () => {
        const file = await readAuthFile(home);
        file.profiles[profile.name] = profile;
        await writeAuthFile(file, home);
      });
    },
    // Persist refreshed tokens for an existing profile, preserving createdAt. A
    // no-op if the profile no longer exists (e.g. removed in another session).
    async updateTokens(name: string, tokens: TTokens, home: string = homedir()): Promise<void> {
      await withAuthFileLock(home, async () => {
        const file = await readAuthFile(home);
        const existing = file.profiles[name];
        if (existing === undefined) return;
        file.profiles[name] = { ...existing, tokens };
        await writeAuthFile(file, home);
      });
    },
    async removeProfile(name: string | undefined, home: string = homedir()): Promise<string[]> {
      return withAuthFileLock(home, async () => {
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
