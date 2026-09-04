import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { generateSessionId } from "../../src/session/index.js";
import type { RunState } from "../../src/session/state.js";

const FIXTURE = join(import.meta.dirname, "../fixtures/crash-run/simulate-exec-signal.ts");

async function readLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!buffer.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
  return buffer;
}

describe("integration — signaled exec process finalizes run.json", () => {
  test.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const)(
    "%s writes status: failed and exits with %i",
    async (signal, expectedExitCode) => {
      const cwd = mkdtempSync(join(tmpdir(), "corbits-exec-signal-cwd-"));
      const home = mkdtempSync(join(tmpdir(), "corbits-exec-signal-home-"));
      const sessionId = generateSessionId();

      try {
        const proc = Bun.spawn(["bun", "run", FIXTURE], {
          cwd,
          env: { ...process.env, HOME: home, SIGNAL_TEST_SESSION_ID: sessionId },
          stdout: "pipe",
          stderr: "pipe",
        });

        const output = await readLine(proc.stdout);
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
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
