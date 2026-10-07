import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { generateSessionId } from "../src/session/index.js";
import type { RunState } from "../src/session/state.js";
import { spawnSignalFixture } from "./signal-helpers.js";

const FIXTURE = join(
  import.meta.dirname,
  "../fixtures/crash-run/simulate-signal.ts",
);

describe("integration — signal finalizes run.json", () => {
  test.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const)(
    "%s writes status: failed and exits with %i",
    async (signal, expectedExitCode) => {
      const sessionId = generateSessionId();
      const { proc, output, cleanup } = await spawnSignalFixture({
        fixture: FIXTURE,
        cwdPrefix: "corbits-signal-cwd-",
        homePrefix: "corbits-signal-home-",
        sessionId,
      });

      try {
        const [runDir] = output.split("\n");
        if (runDir === undefined || runDir.length === 0) {
          throw new Error(
            `fixture did not report a run directory: ${JSON.stringify(output)}`,
          );
        }

        proc.kill(signal);
        const exitCode = await proc.exited;

        expect(exitCode).toBe(expectedExitCode);

        // The hint names the session for resume, goes to stderr only, and
        // emits exactly once under a racing signal.
        const errText = await new Response(proc.stderr).text();
        const hint = `Run corbits resume ${sessionId}`;
        expect(errText).toContain(hint);
        expect(errText.split(hint).length - 1).toBe(1);

        // The fixture parks two "running" writes behind setTestWriteGate
        // until markCrashed() flips, so no straggler rename wins over "failed".
        const runJsonPath = join(runDir, "run.json");
        const raw = readFileSync(runJsonPath, "utf8");
        const state = JSON.parse(raw) as RunState;

        expect(state.status).toBe("failed");
        expect(state.finishedAt).toBeGreaterThan(0);
        expect(state.error).toBe(`terminated by ${signal}`);
        expect(state.task).toBe("simulated signal task");
        expect(state.turnsUsed).toBe(3);
      } finally {
        cleanup();
      }
    },
    15_000,
  );
});
