import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type } from "arktype";

import { createAuthStore, type BaseTokens } from "./store.js";

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
  "../../tests/fixtures/auth-store-writer.ts",
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
      const names = Array.from(
        { length: 16 },
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
      const store = createAuthStore<TestTokens>({
        filename: "test-auth.json",
        settingsDirName: TEST_SETTINGS_DIR,
        isTokens: isTestTokens,
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
      await expect(second).resolves.toBeUndefined();

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
      ).resolves.toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("fails closed with manual recovery guidance when an orphan lock exists", async () => {
    const home = await mkdtemp(join(tmpdir(), "oauth-store-orphan-"));
    try {
      const store = createAuthStore<TestTokens>({
        filename: "test-auth.json",
        settingsDirName: TEST_SETTINGS_DIR,
        isTokens: isTestTokens,
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
