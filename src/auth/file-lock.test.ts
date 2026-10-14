import {
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { withMockedModule } from "../../testkit/mock-module.js";

// File-lock level pins: every credential lock (the auth store's and the
// codex refresh lock's) routes through this primitive, so its contract is
// what the two consumers' horizons and release semantics lean on. Flags gate
// each injected failure to its own test; undefined keeps every call on the
// real module.
let failingReadPath: string | undefined;
let failingUnlinkPath: string | undefined;
await withMockedModule(
  import.meta.resolve("node:fs/promises"),
  (real: typeof import("node:fs/promises")) => ({
    ...real,
    readFile: async (...args: Parameters<typeof real.readFile>) => {
      if (args[0] === failingReadPath) throw new Error("lock read failed");
      return real.readFile(...args);
    },
    unlink: async (...args: Parameters<typeof real.unlink>) => {
      if (args[0] === failingUnlinkPath) throw new Error("lock release failed");
      return real.unlink(...args);
    },
  }),
);

const { withFileLock } = await import("./file-lock.js");

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "file-lock-"));
}

const staleMs = 1_000;

// The store and the refresh lock carry their own failure shapes; the shared
// primitive only delegates to the injected factory.
const timeoutError = (lockPath: string, _timeoutMs: number): Error =>
  new Error(`timed out for ${lockPath}`);

describe("withFileLock", () => {
  test("serializes concurrent holders and removes the lock file", async () => {
    const dir = await tempDir();
    try {
      const lock = join(dir, "x.lock");
      let active = 0;
      let maxActive = 0;
      const results = await Promise.all(
        [0, 1, 2, 3, 4].map((i) =>
          withFileLock(
            lock,
            async () => {
              active += 1;
              maxActive = Math.max(maxActive, active);
              // The file exists while held so a second caller contends on it.
              await stat(lock);
              await new Promise((resolve) => setTimeout(resolve, 10));
              active -= 1;
              return i;
            },
            { timeoutMs: 5_000, retryMs: 10, staleMs, timeoutError },
          ),
        ),
      );
      expect(results).toEqual([0, 1, 2, 3, 4]);
      expect(maxActive).toBe(1);
      await expect(stat(lock)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reports the injected timeout error on a foreign-held lock", async () => {
    const dir = await tempDir();
    try {
      const lock = join(dir, "x.lock");
      await writeFile(lock, "");
      await expect(
        withFileLock(lock, async () => "never", {
          timeoutMs: 100,
          retryMs: 10,
          staleMs,
          timeoutError,
        }),
      ).rejects.toThrow(`timed out for ${lock}`);
      // A timeout never touches the holder's file.
      expect(await readFile(lock, "utf8")).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("takes over a stale untagged lock with the configured staleMs", async () => {
    const dir = await tempDir();
    try {
      const lock = join(dir, "x.lock");
      await writeFile(lock, "legacy-orphan");
      const ancient = new Date(Date.now() - 60_000);
      await utimes(lock, ancient, ancient);
      // The stale horizon is a caller decision: the auth store uses a much
      // smaller value than the refresh lock, and neither is baked in here.
      expect(
        await withFileLock(lock, async () => "taken-over", {
          timeoutMs: 5_000,
          retryMs: 10,
          staleMs,
          timeoutError,
        }),
      ).toBe("taken-over");
      await expect(stat(lock)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("takes over a dead PID holder regardless of the stale horizon", async () => {
    const dir = await tempDir();
    try {
      const lock = join(dir, "x.lock");
      // Dead holder in real claim format: liveness, not age, decides.
      const exited = Bun.spawn(["bun", "--version"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      await exited.exited;
      await writeFile(lock, `${String(exited.pid)}:crashed`);
      expect(
        await withFileLock(lock, async () => "recovered", {
          timeoutMs: 5_000,
          retryMs: 10,
          staleMs: 120_000,
          timeoutError,
        }),
      ).toBe("recovered");
      await expect(stat(lock)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("fenced release keeps a takeover holder's file in place", async () => {
    const dir = await tempDir();
    try {
      const lock = join(dir, "x.lock");
      await withFileLock(
        lock,
        async () => {
          // Simulate a stale-takeover steal landing mid-hold: the victim's
          // release must leave the new holder's file alone.
          await writeFile(lock, "42424242:takeover-holder");
        },
        { timeoutMs: 5_000, retryMs: 10, staleMs, timeoutError },
      );
      expect(await readFile(lock, "utf8")).toBe("42424242:takeover-holder");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("propagates a non-ENOENT read failure during acquisition", async () => {
    const dir = await tempDir();
    try {
      const lock = join(dir, "x.lock");
      await writeFile(lock, "");
      failingReadPath = lock;
      try {
        // Both consumers inherit this off withFileLock: a permission or disk
        // error while reading holder content must surface, not read as "no
        // lock" and restart a blind takeover.
        await expect(
          withFileLock(lock, async () => "never", {
            timeoutMs: 1_000,
            retryMs: 10,
            staleMs,
            timeoutError,
          }),
        ).rejects.toThrow("lock read failed");
      } finally {
        failingReadPath = undefined;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("surfaces a non-ENOENT release failure instead of swallowing it", async () => {
    const dir = await tempDir();
    try {
      const lock = join(dir, "x.lock");
      failingUnlinkPath = lock;
      try {
        // The work value is discarded in favor of the release outcome; with
        // ENOENT-only tolerance, anything else means the lock file survived.
        await expect(
          withFileLock(lock, async () => "done", {
            timeoutMs: 1_000,
            retryMs: 10,
            staleMs,
            timeoutError,
          }),
        ).rejects.toThrow("lock release failed");
        await expect(readFile(lock, "utf8")).resolves.toContain(
          String(process.pid),
        );
      } finally {
        failingUnlinkPath = undefined;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
