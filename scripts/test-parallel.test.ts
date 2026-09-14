import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runWithWatchdog } from "./test-parallel.js";

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// These probes are `bun -e` one-liners, so they never import project modules
// and finish in seconds. The tick test keeps a ~0.7s stall window: under the
// `--parallel` load this runner exists to enable, a delayed output tick can
// look like a stall against a tighter window, so the window keeps several
// ticks of scheduling headroom while a broken never-resetting timer still
// fires mid-run (the tick test's total runtime exceeds the window). The
// remaining tests drive children that never emit output, so their stall is
// declared deterministically on the watchdog's first tick; they use a short
// window so the suite does not pay the tick test's headroom in wall clock.
const TEST_STALL_MS = 700;
const SILENT_CHILD_STALL_MS = 250;

describe("runWithWatchdog", () => {
  test("passes through a successful run without retrying", async () => {
    const chunks: string[] = [];
    const result = await runWithWatchdog({
      command: process.execPath,
      args: ["-e", 'console.log("hello-parallel")'],
      stallMs: 5_000,
      onOutput: (chunk) => chunks.push(Buffer.from(chunk).toString("utf8")),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stalled).toBe(false);
    expect(result.attempts).toBe(1);
    expect(chunks.join("")).toContain("hello-parallel");
  });

  test("passes through a failing run without retrying", async () => {
    const result = await runWithWatchdog({
      command: process.execPath,
      args: ["-e", "process.exit(3)"],
      stallMs: 5_000,
      onStall: () => {
        throw new Error("must not stall on a clean failure");
      },
    });
    expect(result.exitCode).toBe(3);
    expect(result.stalled).toBe(false);
    expect(result.attempts).toBe(1);
  });

  test("output resets the stall timer", async () => {
    // Prints every 120ms for ~1s against a 0.7s stall window: a broken
    // timer that never reset would fire mid-run.
    const result = await runWithWatchdog({
      command: process.execPath,
      args: [
        "-e",
        "for (let i = 0; i < 8; i++) { console.log('tick', i); await new Promise(r => setTimeout(r, 120)); }",
      ],
      stallMs: TEST_STALL_MS,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stalled).toBe(false);
    expect(result.attempts).toBe(1);
  });

  test("retries after a stall and returns the second attempt's result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "test-parallel-retry-"));
    const flag = join(dir, "attempted");
    const code = `
      const fs = require("node:fs");
      if (fs.existsSync(${JSON.stringify(flag)})) {
        console.log("second attempt");
      } else {
        fs.writeFileSync(${JSON.stringify(flag)}, "1");
        setTimeout(() => {}, 30_000);
      }
    `;
    const stalls: [number, number][] = [];
    const result = await runWithWatchdog({
      command: process.execPath,
      args: ["-e", code],
      stallMs: SILENT_CHILD_STALL_MS,
      onStall: (attempt, max) => stalls.push([attempt, max]),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stalled).toBe(false);
    expect(result.attempts).toBe(2);
    expect(stalls).toEqual([[1, 3]]);
  });

  test("a stall-declared run that exits on its own keeps its code and is not retried", async () => {
    // Ignores SIGTERM so the watchdog's stall kill cannot take it out, then
    // exits 3 on its own well after the stall window (so the stall is
    // declared first). The real code must survive and the run must not retry.
    const result = await runWithWatchdog({
      command: process.execPath,
      args: [
        "-e",
        'process.on("SIGTERM", () => {}); setTimeout(() => process.exit(3), 600);',
      ],
      stallMs: SILENT_CHILD_STALL_MS,
      onStall: () => {
        throw new Error("must not retry a run that exited on its own");
      },
    });
    expect(result.exitCode).toBe(3);
    expect(result.stalled).toBe(false);
    expect(result.attempts).toBe(1);
  });

  // Two stall windows (2 x 1.5s) plus kill/retry overhead exceed the
  // default 5s timeout when a delayed first tick doubles one attempt
  // (tickMs == stallMs with a strict `>` check fires on the second tick).
  test("gives up after the final attempt with exit code 1", async () => {
    const stalls: [number, number][] = [];
    const result = await runWithWatchdog({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 30_000)"],
      stallMs: SILENT_CHILD_STALL_MS,
      attempts: 2,
      onStall: (attempt, max) => stalls.push([attempt, max]),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stalled).toBe(true);
    expect(result.attempts).toBe(2);
    // The final stall is reported by the exit code, not a retry notice.
    expect(stalls).toEqual([[1, 2]]);
  }, 10_000);

  test("kills the whole process group, including the child's own children", async () => {
    const dir = mkdtempSync(join(tmpdir(), "test-parallel-group-"));
    const pidFile = join(dir, "grandchild.pid");
    const code = `
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      const grandchild = spawn("sleep", ["30"], { stdio: "ignore" });
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));
      setTimeout(() => {}, 30_000);
    `;
    const result = await runWithWatchdog({
      command: process.execPath,
      args: ["-e", code],
      stallMs: SILENT_CHILD_STALL_MS,
      attempts: 1,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stalled).toBe(true);

    const grandchildPid = Number(readFileSync(pidFile, "utf8"));
    // Reaped processes disappear from the pid namespace, but allow a brief
    // window for the kernel to reap before concluding the kill failed.
    const deadline = Date.now() + 2_000;
    while (processAlive(grandchildPid) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(processAlive(grandchildPid)).toBe(false);
  });
});
