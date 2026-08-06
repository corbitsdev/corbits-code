import { spawn } from "node:child_process";

import { createRgCollector, type RgOutcome } from "./rg-output.js";

const RG_TIMEOUT_MS = 10_000;
// Cap collected stdout so a runaway pattern cannot OOM the process before the
// line-cap post-processing runs.
export const MAX_OUTPUT_BYTES = 512_000;

export type RgResult = RgOutcome | { kind: "unavailable" };

export type RgLimits = {
  timeoutMs?: number;
  maxOutputBytes?: number;
};

// The subset of a spawned child this module drives. Taking it as a parameter
// lets the run be exercised with a scripted event order, which is the only way
// to pin down behavior that otherwise depends on how a platform happens to
// deliver pipe data.
export type RgChild = {
  pid: number | undefined;
  stdout: { on: (event: "data", listener: (chunk: unknown) => void) => unknown };
  stderr: { on: (event: "data", listener: (chunk: unknown) => void) => unknown };
  on: ((event: "error", listener: (err: Error) => void) => unknown) &
    ((event: "close", listener: (code: number | null) => void) => unknown);
  kill: (signal?: NodeJS.Signals) => unknown;
};

export type SpawnRg = (rgArgs: string[], cwd: string, signal: AbortSignal) => RgChild;

const spawnRg: SpawnRg = (rgArgs, cwd, signal) =>
  spawn("rg", rgArgs, {
    cwd,
    signal,
    // Process-group leader so a kill reaches any grandchildren.
    detached: process.platform !== "win32",
  }) as unknown as RgChild;

export function runRg(
  rgArgs: string[],
  cwd: string,
  signal: AbortSignal,
  limits: RgLimits = {},
  spawnChild: SpawnRg = spawnRg,
): Promise<RgResult> {
  const timeoutMs = limits.timeoutMs ?? RG_TIMEOUT_MS;
  const maxOutputBytes = limits.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  return new Promise((resolve) => {
    const child = spawnChild(rgArgs, cwd, signal);
    const collector = createRgCollector(maxOutputBytes);
    let stderr = "";
    let settled = false;

    const killTree = (): void => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // already dead
        }
      }
    };

    // Every path settles here, so whichever of data/close/timeout arrives first
    // stops the timer and reaps the child exactly once.
    const finish = (result: RgResult | undefined): void => {
      if (result === undefined || settled) return;
      settled = true;
      clearTimeout(timer);
      killTree();
      resolve(result);
    };

    const timer = setTimeout(() => finish(collector.timeout(timeoutMs)), timeoutMs);

    child.stdout.on("data", (chunk) => finish(collector.push(String(chunk))));
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => {
      // ENOENT means rg is not installed: signal a fallback, not an error.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") finish({ kind: "unavailable" });
      else finish({ kind: "error", message: err.message });
    });
    child.on("close", (code) => finish(collector.close(code, stderr)));
  });
}
