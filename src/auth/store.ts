import {
  mkdir,
  open,
  readFile,
  rename,
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
  updateTokens: (name: string, tokens: TTokens, home?: string) => Promise<void>;
  // Remove one profile, or all profiles when `name` is undefined. Returns the
  // names removed.
  removeProfile: (name: string | undefined, home?: string) => Promise<string[]>;
}

export interface AuthStoreOptions<TTokens extends BaseTokens> {
  // Filename under the injected settings directory (e.g. "codex-auth.json").
  filename: string;
  settingsDirName: string;
  isTokens: (value: unknown) => value is TTokens;
}

interface AuthFile<TTokens extends BaseTokens> {
  profiles: Record<string, AuthProfile<TTokens>>;
}

const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 1_000;

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
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    let lock;

    while (true) {
      try {
        lock = await open(lockPath, "wx", 0o600);
        break;
      } catch (error) {
        if (!isErrnoCode(error, "EEXIST")) throw error;
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
    // Persist refreshed tokens for an existing profile, preserving createdAt. A
    // no-op if the profile no longer exists (e.g. removed in another session).
    async updateTokens(
      name: string,
      tokens: TTokens,
      home: string = homedir(),
    ): Promise<void> {
      await enqueueAuthFileOp(home, async () => {
        const file = await readAuthFile(home);
        const existing = file.profiles[name];
        if (existing === undefined) return;
        file.profiles[name] = { ...existing, tokens };
        await writeAuthFile(file, home);
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
