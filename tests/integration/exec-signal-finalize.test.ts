import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { generateSessionId } from "../../src/session/index.js";
import type { RunState } from "../../src/session/state.js";
import { spawnSignalFixture } from "./signal-helpers.js";

const FIXTURE = join(
  import.meta.dirname,
  "../fixtures/crash-run/simulate-exec-signal.ts",
);

describe("integration — signaled exec process finalizes run.json", () => {
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
        cwdPrefix: "corbits-exec-signal-cwd-",
        homePrefix: "corbits-exec-signal-home-",
        sessionId,
      });

      try {
        const [runDir] = output.split("\n");
        if (runDir === undefined || runDir.length === 0) {
          const errText = await new Response(proc.stderr).text();
          throw new Error(
            `fixture did not report a run directory: ${JSON.stringify(output)} stderr=${errText}`,
          );
        }

        proc.kill(signal);
        const exitCode = await proc.exited;

        expect(exitCode).toBe(expectedExitCode);

        const runJsonPath = join(runDir, "run.json");
        const raw = readFileSync(runJsonPath, "utf8");
        const state = JSON.parse(raw) as RunState;

        expect(state.status).toBe("failed");
        expect(state.status).not.toBe("running");
        expect(state.finishedAt).toBeGreaterThan(0);
        expect(state.error).toBe(`terminated by ${signal}`);
        expect(state.task).toBe("headless exec signal task");
        expect(state.turnsUsed).toBe(5);
      } finally {
        cleanup();
      }
    },
    15_000,
  );
});
