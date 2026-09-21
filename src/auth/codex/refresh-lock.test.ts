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
import {
  CodexRefreshLockTimeoutError,
  withCodexRefreshLock,
} from "./refresh-lock.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "cl8628-lock-"));
}

describe("codex refresh lock", () => {
  test("concurrent holders serialize and the lock file is removed", async () => {
    const dir = await tempDir();
    try {
      const lock = join(dir, "refresh.lock");
      let active = 0;
      let maxActive = 0;
      const results = await Promise.all(
        [0, 1, 2, 3, 4].map((i) =>
          withCodexRefreshLock(lock, async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            // The file exists while held so a second process contends on it.
            await stat(lock);
            await new Promise((resolve) => setTimeout(resolve, 20));
            active -= 1;
            return i;
          }),
        ),
      );
      expect(results).toEqual([0, 1, 2, 3, 4]);
      expect(maxActive).toBe(1);
      await expect(stat(lock)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a foreign-held lock times out with a recovery hint", async () => {
    const dir = await tempDir();
    try {
      const lock = join(dir, "refresh.lock");
      // Simulate a lock held by another process: withCodexRefreshLock never
      // created it, so only the file path (not the in-memory chain) applies.
      await writeFile(lock, "");
      let failure: unknown;
      try {
        await withCodexRefreshLock(lock, async () => "never", {
          timeoutMs: 100,
          retryMs: 10,
        });
      } catch (err) {
        failure = err;
      }
      expect(failure).toBeInstanceOf(CodexRefreshLockTimeoutError);
      expect((failure as CodexRefreshLockTimeoutError).lockPath).toBe(lock);
      expect((failure as CodexRefreshLockTimeoutError).message).toContain(
        "remove this lock file manually and retry",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a stale lock from a crashed holder is taken over", async () => {
    const dir = await tempDir();
    try {
      const lock = join(dir, "refresh.lock");
      await writeFile(lock, "");
      const ancient = new Date(Date.now() - 60_000);
      await utimes(lock, ancient, ancient);
      const result = await withCodexRefreshLock(
        lock,
        async () => "taken-over",
        {
          timeoutMs: 5_000,
          staleMs: 1_000,
        },
      );
      expect(result).toBe("taken-over");
      await expect(stat(lock)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a crashed holder's lock is taken over under default options", async () => {
    const dir = await tempDir();
    try {
      const lock = join(dir, "refresh.lock");
      // Simulate a crashed holder in the real tag format but with a PID that
      // is already dead: takeover must fire via liveness, not the stale
      // horizon (which defaults far above the default timeout).
      const exited = Bun.spawn(["bun", "--version"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      await exited.exited;
      await writeFile(lock, `${String(exited.pid)}:crashed-holder`);
      const result = await withCodexRefreshLock(lock, async () => "recovered");
      expect(result).toBe("recovered");
      await expect(stat(lock)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a belated release never deletes a takeover holder's lock", async () => {
    const dir = await tempDir();
    try {
      const lock = join(dir, "refresh.lock");
      await withCodexRefreshLock(lock, async () => {
        // Simulate a stale-takeover steal landing mid-hold: the victim's
        // release must leave the new holder's file alone.
        await writeFile(lock, "42424242:takeover-holder");
      });
      expect(await readFile(lock, "utf8")).toBe("42424242:takeover-holder");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("same-process queue wait is bounded by the timeout", async () => {
    const dir = await tempDir();
    try {
      const lock = join(dir, "refresh.lock");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = withCodexRefreshLock(lock, async () => {
        await gate;
        return "first";
      });
      // The second waiter queues behind the first in memory, outside the
      // file timer: it must still give up within its own timeout.
      await expect(
        withCodexRefreshLock(lock, async () => "second", {
          timeoutMs: 100,
          retryMs: 10,
        }),
      ).rejects.toBeInstanceOf(CodexRefreshLockTimeoutError);
      release();
      expect(await first).toBe("first");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a lock held by another process blocks acquisition until released", async () => {
    const dir = await tempDir();
    const holderPath = new URL(
      "../../../tests/fixtures/codex-refresh-lock/hold-lock.ts",
      import.meta.url,
    ).pathname;
    const lock = join(dir, "refresh.lock");
    const proc = Bun.spawn(["bun", "run", holderPath, lock, "1500"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      // Wait until the holder process actually holds the file lock.
      if (proc.stdout === null) throw new Error("holder has no stdout pipe");
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let output = "";
      const deadline = Date.now() + 10_000;
      try {
        while (!output.includes("held")) {
          if (Date.now() > deadline)
            throw new Error("lock holder never acquired the lock");
          const { value, done } = await reader.read();
          if (done) break;
          output += decoder.decode(value, { stream: true });
        }
      } finally {
        reader.releaseLock();
      }
      expect(output).toContain("held");

      // While the other process holds it, acquisition times out instead of
      // overlapping the grant.
      let failure: unknown;
      try {
        await withCodexRefreshLock(lock, async () => "never", {
          timeoutMs: 300,
          retryMs: 10,
        });
      } catch (err) {
        failure = err;
      }
      expect(failure).toBeInstanceOf(CodexRefreshLockTimeoutError);

      // Once the holder exits and releases, the lock is acquirable again.
      await proc.exited;
      expect(await withCodexRefreshLock(lock, async () => "acquired")).toBe(
        "acquired",
      );
    } finally {
      proc.kill();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
