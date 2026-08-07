import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { generateSessionId } from "../../src/session/index.js";
import type { RunState } from "../../src/session/state.js";
import { isResumableByDefault } from "../../src/tui/pick-session.js";

const FIXTURE = join(import.meta.dirname, "../fixtures/crash-run/simulate-crash.ts");

describe("integration — crash finalizes run.json", () => {
  test("uncaughtException writes status: crashed with finishedAt, racing in-flight snapshot writes", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "corbits-crash-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "corbits-crash-home-"));
    const sessionId = generateSessionId();

    try {
      const proc = Bun.spawn(["bun", "run", FIXTURE], {
        cwd,
        env: { ...process.env, HOME: home, CRASH_TEST_SESSION_ID: sessionId },
        stdout: "pipe",
        stderr: "pipe",
      });

      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();

      expect(exitCode).toBe(1);
      expect(stderr).toContain("uncaughtException: Error: simulated crash");

      const runJsonPath = join(stdout.trim(), "run.json");
      const raw = readFileSync(runJsonPath, "utf8");
      const state = JSON.parse(raw) as RunState;

      // The fixture also parks two unawaited straggler "running" snapshot
      // writes behind a test-only gate (setTestWriteGate) that it releases
      // only after the crash handler has flipped isCrashed(), guaranteeing
      // both are still queued — not dispatched to the kernel — at that
      // moment. Without the isCrashed() guard in saveState
      // (src/session/state.ts), one of those would win the rename() race
      // once released and this would read back "running".
      expect(state.status).toBe("crashed");
      expect(state.finishedAt).toBeGreaterThan(0);
      expect(state.error).toContain("simulated crash");
      expect(state.task).toBe("simulated crash task");
      expect(state.model).toBe("test-provider:test-model");
      expect(isResumableByDefault(state)).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);
});
