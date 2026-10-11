import { describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type } from "arktype";

import { withMockedModule } from "../../testkit/mock-module.js";
import type { BaseTokens } from "./store.js";

let failingUnlinkPath: string | undefined;
await withMockedModule(
  import.meta.resolve("node:fs/promises"),
  (real: typeof import("node:fs/promises")) => ({
    ...real,
    unlink: async (...args: Parameters<typeof real.unlink>) => {
      if (args[0] === failingUnlinkPath) throw new Error("lock release failed");
      return real.unlink(...args);
    },
  }),
);

const { createAuthStore } = await import("./store.js");

type TestTokens = BaseTokens & { accountId?: string };

const TestTokensShape = type({
  access: "string",
  refresh: "string",
  expiresAt: "number",
  "accountId?": "string",
});

function isTestTokens(value: unknown): value is TestTokens {
  return !(TestTokensShape(value) instanceof type.errors);
}

const TEST_SETTINGS_DIR = ".test-settings";

const authStoreWriter = join(
  import.meta.dirname,
  "../../fixtures/auth-store-writer.ts",
);

describe("createAuthStore", () => {
  test("serializes concurrent profile saves and token updates across processes", async () => {
    const home = await mkdtemp(join(tmpdir(), "oauth-store-concurrent-"));
    try {
      const store = createAuthStore<TestTokens>({
        filename: "concurrent-auth.json",
        settingsDirName: TEST_SETTINGS_DIR,
        isTokens: isTestTokens,
      });
      await store.saveProfile(
        {
          name: "existing",
          tokens: { access: "old", refresh: "old-refresh", expiresAt: 1 },
          createdAt: 10,
        },
        home,
      );

      const barrier = join(home, "start");
      // Each writer is a full `bun` process (~65 MB: the runtime plus the
      // store's arktype validators), and the barrier holds every one of them
      // at that footprint at once. 16 concurrent writers made this the suite's
      // peak-RAM event (~1.7 GB); a handful still races every lock window the
      // queue serializes, at a fraction of the footprint.
      const names = Array.from(
        { length: 6 },
        (_, index) => `profile-${String(index)}`,
      );
      const processes = [
        ...names.map((name) =>
          Bun.spawn(
            [process.execPath, authStoreWriter, home, barrier, "save", name],
            {
              stdout: "ignore",
              stderr: "pipe",
            },
          ),
        ),
        Bun.spawn(
          [
            process.execPath,
            authStoreWriter,
            home,
            barrier,
            "update",
            "new-access",
          ],
          {
            stdout: "ignore",
            stderr: "pipe",
          },
        ),
      ];

      await Bun.sleep(50);
      await writeFile(barrier, "go");
      const exitCodes = await Promise.all(
        processes.map((child) => child.exited),
      );
      const errors = await Promise.all(
        processes.map((child) => new Response(child.stderr).text()),
      );
      expect(exitCodes, errors.join("\n")).toEqual(processes.map(() => 0));

      const profiles = await store.listProfiles(home);
      expect(profiles.map((profile) => profile.name)).toEqual(
        ["existing", ...names].sort(),
      );
      expect(profiles.find((profile) => profile.name === "existing")).toEqual({
        name: "existing",
        tokens: {
          access: "new-access",
          refresh: "refresh-new-access",
          expiresAt: 2,
        },
        createdAt: 10,
      });
      for (const name of names) {
        expect(profiles.find((profile) => profile.name === name)).toEqual({
          name,
          tokens: {
            access: `access-${name}`,
            refresh: `refresh-${name}`,
            expiresAt: 1,
          },
          createdAt: 1,
        });
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("keeps a same-process burst of profile saves without shared-deadline loss", async () => {
    const home = await mkdtemp(join(tmpdir(), "oauth-store-burst-"));
    try {
      const store = createAuthStore<TestTokens>({
        filename: "test-auth.json",
        settingsDirName: TEST_SETTINGS_DIR,
        isTokens: isTestTokens,
      });

      // Without the per-path queue, a large same-process burst shares one lock
      // deadline from invoke time and some waiters time out. With the queue,
      // each save gets its own window and all land.
      const names = Array.from(
        { length: 50 },
        (_, index) => `profile-${String(index)}`,
      );
      const results = await Promise.allSettled(
        names.map((name) =>
          store.saveProfile(
            {
              name,
              tokens: {
                access: `access-${name}`,
                refresh: `refresh-${name}`,
                expiresAt: 1,
              },
              createdAt: 1,
            },
            home,
          ),
        ),
      );

      const failures = results.flatMap((result, index) =>
        result.status === "rejected"
          ? [`${names[index]}: ${String(result.reason)}`]
          : [],
      );
      expect(failures).toEqual([]);
      expect(
        (await store.listProfiles(home)).map((profile) => profile.name),
      ).toEqual([...names].sort());
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("gives queued same-process writes their own lock window", async () => {
    const home = await mkdtemp(join(tmpdir(), "oauth-store-queue-"));
    try {
      // A short lock window keeps the queued write's handoff fast without
      // changing what is asserted; production keeps the 1s default.
      const store = createAuthStore<TestTokens>({
        filename: "test-auth.json",
        settingsDirName: TEST_SETTINGS_DIR,
        isTokens: isTestTokens,
        lockTimeoutMs: 100,
      });
      await store.saveProfile(
        {
          name: "work",
          tokens: { access: "a", refresh: "r", expiresAt: 1 },
          createdAt: 1,
        },
        home,
      );

      // Hold the lock until the head of the same-process queue times out; the
      // queued write must still get its own lock window after we release.
      // `second` may already be polling when `first` rejects — release must land
      // inside LOCK_TIMEOUT_MS of that handoff.
      const lockPath = `${store.authPath(home)}.lock`;
      await writeFile(lockPath, "foreign", { mode: 0o600 });

      const first = store.updateTokens(
        "work",
        { access: "first", refresh: "r1", expiresAt: 2 },
        home,
      );
      const second = store.updateTokens(
        "work",
        { access: "second", refresh: "r2", expiresAt: 3 },
        home,
      );

      await expect(first).rejects.toThrow(
        "Timed out waiting for OAuth credential lock",
      );
      await rm(lockPath, { force: true });
      await expect(second).resolves.toEqual({
        name: "work",
        tokens: { access: "second", refresh: "r2", expiresAt: 3 },
        createdAt: 1,
      });

      expect((await store.loadProfile("work", home))?.tokens.access).toBe(
        "second",
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("round-trips profiles under an injected home and survives corrupt files", async () => {
    const home = await mkdtemp(join(tmpdir(), "oauth-store-"));
    try {
      const store = createAuthStore<TestTokens>({
        filename: "test-auth.json",
        settingsDirName: TEST_SETTINGS_DIR,
        isTokens: isTestTokens,
      });
      expect(store.authPath(home)).toBe(
        join(home, TEST_SETTINGS_DIR, "test-auth.json"),
      );
      expect(await store.listProfiles(home)).toEqual([]);

      const profile = {
        name: "work",
        tokens: { access: "a", refresh: "r", expiresAt: 1 },
        createdAt: 10,
      };
      await store.saveProfile(profile, home);
      expect(await store.loadProfile("work", home)).toEqual(profile);

      await store.updateTokens(
        "work",
        { access: "a2", refresh: "r2", expiresAt: 2 },
        home,
      );
      const updated = await store.loadProfile("work", home);
      expect(updated?.tokens.access).toBe("a2");
      expect(updated?.createdAt).toBe(10);

      await store.saveProfile(
        {
          name: "work",
          tokens: {
            access: "replacement",
            refresh: "new-refresh",
            expiresAt: 3,
          },
          createdAt: 20,
        },
        home,
      );
      await store.updateTokens(
        "work",
        { access: "stale-refresh", refresh: "rotated-old", expiresAt: 4 },
        home,
        "r2",
      );
      expect(await store.loadProfile("work", home)).toEqual({
        name: "work",
        tokens: { access: "replacement", refresh: "new-refresh", expiresAt: 3 },
        createdAt: 20,
      });

      await store.updateTokens(
        "gone",
        { access: "x", refresh: "x", expiresAt: 0 },
        home,
      );
      expect(await store.loadProfile("gone", home)).toBeUndefined();

      expect(await store.removeProfile("work", home)).toEqual(["work"]);
      expect(await store.removeProfile("work", home)).toEqual([]);

      await writeFile(store.authPath(home), "{not json", { mode: 0o600 });
      expect(await store.listProfiles(home)).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("surfaces a credential lock release failure after a successful write", async () => {
    const home = await mkdtemp(join(tmpdir(), "oauth-store-release-error-"));
    try {
      const store = createAuthStore<TestTokens>({
        filename: "test-auth.json",
        settingsDirName: TEST_SETTINGS_DIR,
        isTokens: isTestTokens,
      });
      failingUnlinkPath = `${store.authPath(home)}.lock`;

      await expect(
        store.saveProfile(
          {
            name: "work",
            tokens: { access: "a", refresh: "r", expiresAt: 1 },
            createdAt: 1,
          },
          home,
        ),
      ).rejects.toThrow("lock release failed");
    } finally {
      failingUnlinkPath = undefined;
      await rm(home, { recursive: true, force: true });
    }
  });

  test("does not mask a read-modify-write callback failure during release", async () => {
    const home = await mkdtemp(join(tmpdir(), "oauth-store-error-precedence-"));
    try {
      const store = createAuthStore<TestTokens>({
        filename: "test-auth.json",
        settingsDirName: TEST_SETTINGS_DIR,
        isTokens: isTestTokens,
      });
      const profile = {
        name: "work",
        tokens: { access: "a", refresh: "r", expiresAt: 1 },
        createdAt: 1,
      };
      await store.saveProfile(profile, home);

      const failingStore = createAuthStore<TestTokens>({
        filename: "test-auth.json",
        settingsDirName: TEST_SETTINGS_DIR,
        isTokens: (_value: unknown): _value is TestTokens => {
          throw new Error("validator failed");
        },
      });
      failingUnlinkPath = `${store.authPath(home)}.lock`;
      await expect(failingStore.saveProfile(profile, home)).rejects.toThrow(
        "validator failed",
      );
    } finally {
      failingUnlinkPath = undefined;
      await rm(home, { recursive: true, force: true });
    }
  });

  test("releases the credential lock when a read-modify-write callback fails", async () => {
    const home = await mkdtemp(join(tmpdir(), "oauth-store-error-"));
    try {
      const store = createAuthStore<TestTokens>({
        filename: "test-auth.json",
        settingsDirName: TEST_SETTINGS_DIR,
        isTokens: isTestTokens,
      });
      const profile = {
        name: "work",
        tokens: { access: "a", refresh: "r", expiresAt: 1 },
        createdAt: 1,
      };
      await store.saveProfile(profile, home);

      const failingStore = createAuthStore<TestTokens>({
        filename: "test-auth.json",
        settingsDirName: TEST_SETTINGS_DIR,
        isTokens: (_value: unknown): _value is TestTokens => {
          throw new Error("validator failed");
        },
      });
      await expect(failingStore.saveProfile(profile, home)).rejects.toThrow(
        "validator failed",
      );

      await expect(
        store.updateTokens("work", profile.tokens, home),
      ).resolves.toEqual(profile);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("takes over a dead-holder lock instead of timing out", async () => {
    const home = await mkdtemp(join(tmpdir(), "oauth-store-takeover-"));
    try {
      const store = createAuthStore<TestTokens>({
        filename: "test-auth.json",
        settingsDirName: TEST_SETTINGS_DIR,
        isTokens: isTestTokens,
      });
      const lockPath = `${store.authPath(home)}.lock`;
      await mkdir(join(home, TEST_SETTINGS_DIR), { recursive: true });
      // The maximum pid_t can never be a live holder: kill(pid, 0) answers
      // ESRCH (or EINVAL), both of which read as dead.
      await writeFile(lockPath, `${2_147_483_647}`, { mode: 0o600 });

      const profile = {
        name: "work",
        tokens: { access: "a", refresh: "r", expiresAt: 1 },
        createdAt: 1,
      };
      await expect(store.saveProfile(profile, home)).resolves.toBeUndefined();
      expect(await store.loadProfile("work", home)).toEqual(profile);
      await expect(readFile(lockPath, "utf8")).rejects.toThrow("ENOENT");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("takes over a dead-holder pid:counter claim instead of timing out", async () => {
    const home = await mkdtemp(join(tmpdir(), "oauth-store-takeover-claim-"));
    try {
      const store = createAuthStore<TestTokens>({
        filename: "test-auth.json",
        settingsDirName: TEST_SETTINGS_DIR,
        isTokens: isTestTokens,
      });
      const lockPath = `${store.authPath(home)}.lock`;
      await mkdir(join(home, TEST_SETTINGS_DIR), { recursive: true });
      // The NEW pid:counter claim format with a certainly-dead PID: kill(pid, 0)
      // answers ESRCH (or EINVAL), both of which read as dead. The counter leg
      // must not stop holderPid from reading the pid leg.
      await writeFile(lockPath, `${2_147_483_647}:99`, { mode: 0o600 });

      const profile = {
        name: "work",
        tokens: { access: "a", refresh: "r", expiresAt: 1 },
        createdAt: 1,
      };
      await expect(store.saveProfile(profile, home)).resolves.toBeUndefined();
      expect(await store.loadProfile("work", home)).toEqual(profile);
      await expect(readFile(lockPath, "utf8")).rejects.toThrow("ENOENT");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("waits on a live-holder lock and times out without touching it", async () => {
    const home = await mkdtemp(join(tmpdir(), "oauth-store-live-"));
    try {
      const store = createAuthStore<TestTokens>({
        filename: "test-auth.json",
        settingsDirName: TEST_SETTINGS_DIR,
        isTokens: isTestTokens,
        lockTimeoutMs: 100,
      });
      const lockPath = `${store.authPath(home)}.lock`;
      await mkdir(join(home, TEST_SETTINGS_DIR), { recursive: true });
      await writeFile(lockPath, `${process.pid}`, { mode: 0o600 });

      await expect(
        store.saveProfile(
          {
            name: "work",
            tokens: { access: "a", refresh: "r", expiresAt: 1 },
            createdAt: 1,
          },
          home,
        ),
      ).rejects.toThrow(
        `Timed out waiting for OAuth credential lock ${lockPath}. ` +
          "If no Corbits process is running, remove this lock file manually and retry.",
      );
      expect(await readFile(lockPath, "utf8")).toBe(`${process.pid}`);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("waits on a live-holder pid:counter claim and times out without touching it", async () => {
    const home = await mkdtemp(join(tmpdir(), "oauth-store-live-claim-"));
    try {
      const store = createAuthStore<TestTokens>({
        filename: "test-auth.json",
        settingsDirName: TEST_SETTINGS_DIR,
        isTokens: isTestTokens,
        lockTimeoutMs: 100,
      });
      const lockPath = `${store.authPath(home)}.lock`;
      await mkdir(join(home, TEST_SETTINGS_DIR), { recursive: true });
      // The NEW pid:counter claim format held by this live process. Never
      // signal it; the waiter must read the pid leg as alive, time out, and
      // leave the claim byte-identical.
      const claim = `${process.pid}:42`;
      await writeFile(lockPath, claim, { mode: 0o600 });

      await expect(
        store.saveProfile(
          {
            name: "work",
            tokens: { access: "a", refresh: "r", expiresAt: 1 },
            createdAt: 1,
          },
          home,
        ),
      ).rejects.toThrow(
        `Timed out waiting for OAuth credential lock ${lockPath}. ` +
          "If no Corbits process is running, remove this lock file manually and retry.",
      );
      expect(await readFile(lockPath, "utf8")).toBe(claim);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("takes over a stale legacy lock but waits on a fresh one", async () => {
    const home = await mkdtemp(join(tmpdir(), "oauth-store-legacy-"));
    try {
      const staleStore = createAuthStore<TestTokens>({
        filename: "stale-auth.json",
        settingsDirName: TEST_SETTINGS_DIR,
        isTokens: isTestTokens,
      });
      const staleLockPath = `${staleStore.authPath(home)}.lock`;
      await mkdir(join(home, TEST_SETTINGS_DIR), { recursive: true });
      await writeFile(staleLockPath, "legacy-orphan", { mode: 0o600 });
      await utimes(staleLockPath, new Date(), new Date(Date.now() - 60_000));

      const profile = {
        name: "work",
        tokens: { access: "a", refresh: "r", expiresAt: 1 },
        createdAt: 1,
      };
      await expect(
        staleStore.saveProfile(profile, home),
      ).resolves.toBeUndefined();
      expect(await staleStore.loadProfile("work", home)).toEqual(profile);

      const freshStore = createAuthStore<TestTokens>({
        filename: "fresh-auth.json",
        settingsDirName: TEST_SETTINGS_DIR,
        isTokens: isTestTokens,
        lockTimeoutMs: 100,
      });
      const freshLockPath = `${freshStore.authPath(home)}.lock`;
      await writeFile(freshLockPath, "legacy-orphan", { mode: 0o600 });
      await expect(freshStore.saveProfile(profile, home)).rejects.toThrow(
        "Timed out waiting for OAuth credential lock",
      );
      expect(await readFile(freshLockPath, "utf8")).toBe("legacy-orphan");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("saves when a contended lock vanishes mid-wait", async () => {
    const home = await mkdtemp(join(tmpdir(), "oauth-store-vanish-"));
    try {
      const store = createAuthStore<TestTokens>({
        filename: "test-auth.json",
        settingsDirName: TEST_SETTINGS_DIR,
        isTokens: isTestTokens,
      });
      const lockPath = `${store.authPath(home)}.lock`;
      await mkdir(join(home, TEST_SETTINGS_DIR), { recursive: true });
      await writeFile(lockPath, `${2_147_483_647}`, { mode: 0o600 });

      // Yank the stale lock out from under the waiter: whether the waiter
      // observes the dead PID, an ENOENT read, or an ENOENT unlink, it must
      // retry the exclusive create and land the save — never throw ENOENT.
      const pending = store.saveProfile(
        {
          name: "work",
          tokens: { access: "a", refresh: "r", expiresAt: 1 },
          createdAt: 1,
        },
        home,
      );
      await rm(lockPath, { force: true });
      await expect(pending).resolves.toBeUndefined();
      expect((await store.loadProfile("work", home))?.tokens.access).toBe("a");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("fails closed with manual recovery guidance when an orphan lock exists", async () => {
    const home = await mkdtemp(join(tmpdir(), "oauth-store-orphan-"));
    try {
      // A short lock window keeps the timeout fast; production keeps 1s.
      const store = createAuthStore<TestTokens>({
        filename: "test-auth.json",
        settingsDirName: TEST_SETTINGS_DIR,
        isTokens: isTestTokens,
        lockTimeoutMs: 100,
      });
      const lockPath = `${store.authPath(home)}.lock`;
      await mkdir(join(home, TEST_SETTINGS_DIR), { recursive: true });
      await writeFile(lockPath, "orphan", { mode: 0o600 });

      await expect(
        store.saveProfile(
          {
            name: "work",
            tokens: { access: "a", refresh: "r", expiresAt: 1 },
            createdAt: 1,
          },
          home,
        ),
      ).rejects.toThrow(
        `Timed out waiting for OAuth credential lock ${lockPath}. ` +
          "If no Corbits process is running, remove this lock file manually and retry.",
      );
      expect(await readFile(lockPath, "utf8")).toBe("orphan");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("drops invalid profile entries instead of wedging on them", async () => {
    const home = await mkdtemp(join(tmpdir(), "oauth-store-"));
    try {
      const store = createAuthStore<TestTokens>({
        filename: "test-auth.json",
        settingsDirName: TEST_SETTINGS_DIR,
        isTokens: isTestTokens,
      });
      await store.saveProfile(
        {
          name: "good",
          tokens: { access: "a", refresh: "r", expiresAt: 1 },
          createdAt: 1,
        },
        home,
      );
      const raw = JSON.parse(await readFile(store.authPath(home), "utf8"));
      const file = type({ profiles: "Record<string, unknown>" })(raw);
      expect(file instanceof type.errors).toBe(false);
      if (file instanceof type.errors) return;
      file.profiles.bad = {
        name: "bad",
        tokens: { access: 42 },
        createdAt: "nope",
      };
      await writeFile(store.authPath(home), JSON.stringify(file), {
        mode: 0o600,
      });
      const names = (await store.listProfiles(home)).map((p) => p.name);
      expect(names).toEqual(["good"]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
