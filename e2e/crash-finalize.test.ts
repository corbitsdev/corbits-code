import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { generateSessionId, sessionDir } from "../src/session/index.js";
import type { RunState } from "../src/session/state.js";
import { createTempDirs } from "../testkit/temporary-dirs.js";

const FIXTURE = join(
  import.meta.dirname,
  "../fixtures/crash-run/simulate-crash.ts",
);
const RUN_END_FIXTURE = join(
  import.meta.dirname,
  "../fixtures/crash-run/simulate-run-end-crash.ts",
);

describe("integration — crash finalizes run.json", () => {
  test("uncaughtException writes status: crashed with finishedAt, racing in-flight snapshot writes", async () => {
    const { cwd, home, cleanup } = createTempDirs(
      "corbits-crash-cwd-",
      "corbits-crash-home-",
    );
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

      // The fixture parks two "running" writes behind setTestWriteGate until
      // isCrashed() flips, so no straggler rename() wins over "crashed".
      expect(state.status).toBe("crashed");
      expect(state.finishedAt).toBeGreaterThan(0);
      expect(state.error).toContain("simulated crash");
      expect(state.task).toBe("simulated crash task");
      expect(state.model).toBe("test-provider:test-model");
      expect(state.turnsUsed).toBe(3);
    } finally {
      cleanup();
    }
  }, 15_000);

  test("a crash after session rotation still writes crashed for the new session", async () => {
    const { cwd, home, cleanup } = createTempDirs(
      "corbits-crash-cwd-",
      "corbits-crash-home-",
    );
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

      // The terminal "done" write must not clear the active-run handle, or the crash writes no record.
      const outgoingRunJsonPath = join(
        sessionDir(cwd, sessionId, home),
        "run.json",
      );
      const outgoingState = JSON.parse(
        readFileSync(outgoingRunJsonPath, "utf8"),
      ) as RunState;
      expect(outgoingState.status).toBe("done");
      expect(outgoingState.turnsUsed).toBe(3);

      const rotatedRunJsonPath = join(stdout.trim(), "run.json");
      const rotatedState = JSON.parse(
        readFileSync(rotatedRunJsonPath, "utf8"),
      ) as RunState;
      expect(rotatedRunJsonPath).toBe(
        join(sessionDir(cwd, rotatedSessionId, home), "run.json"),
      );
      expect(rotatedState.status).toBe("crashed");
      expect(rotatedState.finishedAt).toBeGreaterThan(0);
      expect(rotatedState.error).toContain("simulated crash");
      expect(rotatedState.turnsUsed).toBe(0);
    } finally {
      cleanup();
    }
  }, 15_000);

  test("an unrelated crash while the run-end write is in flight does not report crashed", async () => {
    const { cwd, home, cleanup } = createTempDirs(
      "corbits-crash-cwd-",
      "corbits-crash-home-",
    );
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
      expect(stderr).toContain(
        "uncaughtException: Error: simulated crash during run-end write",
      );

      // finalizeRunState used to clear the active-run handle only after its
      // saveState write resolved; the crash handler then saw a live run and
      // wrote "crashed" via saveCrashState, clobbering the clean finish.
      // Clearing the handle before the await closes that window.
      const runJsonPath = join(stdout.trim(), "run.json");
      const raw = readFileSync(runJsonPath, "utf8");
      const state = JSON.parse(raw) as RunState;
      expect(state.status).not.toBe("crashed");
    } finally {
      cleanup();
    }
  }, 15_000);
});
