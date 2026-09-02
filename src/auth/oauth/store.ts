import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type } from "arktype";
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

const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 15_000;
const STALE_LOCK_MS = 10_000;

const LockOwner = type({
  pid: "number.integer > 0",
  owner: "string",
});

interface LockSnapshot {
  contents: string;
  mtimeMs: number;
}

const LOCK_OWNER_FILE = "owner";
const LOCK_RECLAIM_DIR = "reclaim";

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

async function readLockSnapshot(path: string): Promise<LockSnapshot | undefined> {
  try {
    const ownerPath = join(path, LOCK_OWNER_FILE);
    const contents = await readFile(ownerPath, "utf8");
    const info = await stat(ownerPath);
    return { contents, mtimeMs: info.mtimeMs };
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, "EPERM");
  }
}

async function removeDirectory(path: string): Promise<boolean> {
  try {
    await rmdir(path);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTEMPTY")) return false;
    throw error;
  }
}

async function claimLockForRemoval(path: string): Promise<boolean> {
  try {
    await mkdir(join(path, LOCK_RECLAIM_DIR), { mode: 0o700 });
    return true;
  } catch (error) {
    if (isErrno(error, "EEXIST") || isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

async function removeOwnedLock(path: string, expectedContents: string): Promise<boolean> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (!(await claimLockForRemoval(path))) {
    if (Date.now() >= deadline) return false;
    await Bun.sleep(LOCK_RETRY_MS);
  }
  let removedOwner = false;
  try {
    const current = await readLockSnapshot(path);
    if (current === undefined || current.contents !== expectedContents) return false;
    await unlink(join(path, LOCK_OWNER_FILE));
    removedOwner = true;
  } finally {
    await removeDirectory(join(path, LOCK_RECLAIM_DIR));
    if (removedOwner) await removeDirectory(path);
  }
  return removedOwner;
}

async function createLock(path: string, contents: string): Promise<void> {
  await mkdir(path, { mode: 0o700 });
  const ownerPath = join(path, LOCK_OWNER_FILE);
  try {
    const handle = await open(ownerPath, "wx", 0o600);
    try {
      await handle.writeFile(contents);
    } finally {
      await handle.close();
    }
  } catch (cause) {
    await unlink(ownerPath).catch(() => {});
    await removeDirectory(path).catch(() => false);
    throw new Error(`Failed to create store lock: ${path}`, { cause });
  }
}

function parseLockOwner(snapshot: LockSnapshot | undefined): typeof LockOwner.infer | undefined {
  if (snapshot === undefined) return undefined;
  try {
    const parsed = LockOwner(JSON.parse(snapshot.contents));
    return parsed instanceof type.errors ? undefined : parsed;
  } catch {
    // Locks written by interrupted or older clients have no usable owner metadata.
    return undefined;
  }
}

async function isStaleLock(path: string, snapshot: LockSnapshot | undefined): Promise<boolean> {
  let mtimeMs = snapshot?.mtimeMs;
  if (mtimeMs === undefined) {
    try {
      mtimeMs = (await stat(path)).mtimeMs;
    } catch (error) {
      if (isErrno(error, "ENOENT")) return false;
      throw error;
    }
  }
  if (Date.now() - mtimeMs <= STALE_LOCK_MS) return false;
  const owner = parseLockOwner(snapshot);
  return owner === undefined || !isProcessAlive(owner.pid);
}

async function removeStaleLock(path: string): Promise<boolean> {
  const initial = await readLockSnapshot(path);
  if (!(await isStaleLock(path, initial))) return false;
  if (!(await claimLockForRemoval(path))) return false;
  let shouldRemove = false;
  try {
    const snapshot = await readLockSnapshot(path);
    if (!(await isStaleLock(path, snapshot))) return false;
    if (snapshot !== undefined) await unlink(join(path, LOCK_OWNER_FILE));
    shouldRemove = true;
  } finally {
    await removeDirectory(join(path, LOCK_RECLAIM_DIR));
    if (shouldRemove) await removeDirectory(path);
  }
  return shouldRemove;
}

export async function withStoreFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const contents = JSON.stringify({ pid: process.pid, owner: randomUUID() });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    try {
      await createLock(path, contents);
      break;
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;

      if (await removeStaleLock(path)) continue;
      if (Date.now() >= deadline) throw new Error(`Timed out acquiring store lock: ${path}`);

      await Bun.sleep(LOCK_RETRY_MS);
    }
  }

  try {
    return await fn();
  } finally {
    await removeOwnedLock(path, contents);
  }
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

  // Serialise read-modify-write operations across concurrent CLI processes.
  function withStoreLock<T>(home: string, fn: () => Promise<T>): Promise<T> {
    return withStoreFileLock(`${authPath(home)}.lock`, fn);
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
