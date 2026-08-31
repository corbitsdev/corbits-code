import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { generateSessionId, sessionDir } from "../../src/session/index.js";
import type { RunState } from "../../src/session/state.js";

const FIXTURE = join(import.meta.dirname, "../fixtures/crash-run/simulate-crash.ts");
const RUN_END_FIXTURE = join(
  import.meta.dirname,
  "../fixtures/crash-run/simulate-run-end-crash.ts",
);

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
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);

  test("a crash after session rotation still writes crashed for the new session", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "corbits-crash-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "corbits-crash-home-"));
    const sessionId = generateSessionId();
    const rotatedSessionId = generateSessionId();

    try {
      const proc = Bun.spawn(["bun", "run", FIXTURE], {
        cwd,
        env: {
          ...process.env,
          HOME: home,
          CRASH_TEST_SESSION_ID: sessionId,
          CRASH_TEST_ROTATED_SESSION_ID: rotatedSessionId,
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();

      expect(exitCode).toBe(1);
      expect(stderr).toContain("uncaughtException: Error: simulated crash");

      // The bug this pins: the outgoing session's terminal "done" write must
      // not clear the active-run handle, or the crash below finds it null
      // and never writes a crashed record for the session actually running
      // at the time of the crash.
      const outgoingRunJsonPath = join(sessionDir(cwd, sessionId, home), "run.json");
      const outgoingState = JSON.parse(readFileSync(outgoingRunJsonPath, "utf8")) as RunState;
      expect(outgoingState.status).toBe("done");

      const rotatedRunJsonPath = join(stdout.trim(), "run.json");
      const rotatedState = JSON.parse(readFileSync(rotatedRunJsonPath, "utf8")) as RunState;
      expect(rotatedRunJsonPath).toBe(join(sessionDir(cwd, rotatedSessionId, home), "run.json"));
      expect(rotatedState.status).toBe("crashed");
      expect(rotatedState.finishedAt).toBeGreaterThan(0);
      expect(rotatedState.error).toContain("simulated crash");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);

  test("an unrelated crash while the run-end write is in flight does not report crashed", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "corbits-crash-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "corbits-crash-home-"));
    const sessionId = generateSessionId();

    try {
      const proc = Bun.spawn(["bun", "run", RUN_END_FIXTURE], {
        cwd,
        env: { ...process.env, HOME: home, RUN_END_TEST_SESSION_ID: sessionId },
        stdout: "pipe",
        stderr: "pipe",
      });

      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();

      expect(exitCode).toBe(1);
      expect(stderr).toContain("uncaughtException: Error: simulated crash during run-end write");

      // The bug this pins: finalizeRunState used to clear the active-run
      // handle only after its own saveState write resolved. With the
      // run-end write parked mid-flight (this fixture's gate never
      // releases), the handle stayed live for the entire window, so the
      // crash handler saw a live run and wrote a "crashed" record via
      // saveCrashState — which bypasses the gate — clobbering what should
      // have been a clean finish. Clearing the handle before the await
      // closes that window: the crash handler finds no active run and
      // writes nothing, so the last write to land is the one from the
      // initial saveState above ("running"), never "crashed".
      const runJsonPath = join(stdout.trim(), "run.json");
      const raw = readFileSync(runJsonPath, "utf8");
      const state = JSON.parse(raw) as RunState;
      expect(state.status).not.toBe("crashed");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);
});
