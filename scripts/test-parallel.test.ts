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
// and finish in milliseconds. Stall windows are tiny (300-500ms) to keep the
// file fast while still exercising the watchdog's timing logic.

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
    // Prints every 100ms for ~700ms against a 300ms stall window: a broken
    // timer that never reset would fire on the second tick.
    const result = await runWithWatchdog({
      command: process.execPath,
      args: [
        "-e",
        "for (let i = 0; i < 7; i++) { console.log('tick', i); await new Promise(r => setTimeout(r, 100)); }",
      ],
      stallMs: 300,
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
      stallMs: 300,
      onStall: (attempt, max) => stalls.push([attempt, max]),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stalled).toBe(false);
    expect(result.attempts).toBe(2);
    expect(stalls).toEqual([[1, 3]]);
  });

  test("gives up after the final attempt with exit code 1", async () => {
    const stalls: [number, number][] = [];
    const result = await runWithWatchdog({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 30_000)"],
      stallMs: 300,
      attempts: 2,
      onStall: (attempt, max) => stalls.push([attempt, max]),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stalled).toBe(true);
    expect(result.attempts).toBe(2);
    // The final stall is reported by the exit code, not a retry notice.
    expect(stalls).toEqual([[1, 2]]);
  });

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
      stallMs: 300,
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
