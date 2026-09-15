import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  BoundedShellOutput,
  MAX_SHELL_OUTPUT_BYTES,
} from "../plugins/shell-guard-plugin.js";

// Background run_shell: the starting tool call returns a handle at once and the
// process keeps running past the end of the turn, so tool.boundary fires and
// queued steers land while builds, test suites, and dev servers run. On exit
// the result is pushed to the host via onExit (which delivers it to the
// reactor as a system message on a later turn); shell_collect retrieves or
// cancels by id.

export const MAX_RUNNING_BACKGROUND_SHELLS = 8;
export const MAX_COMPLETED_BACKGROUND_SHELLS = 8;

/**
 * Signals the whole process group. With detached:true the shell is the group
 * leader, so grandchildren (build watchers, test runners' workers) die too.
 */
export function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      child.kill("SIGKILL");
    } else {
      // Negative PID signals the whole process group.
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already exited
    }
  }
}

export interface StartBackgroundShellArgs {
  command: string;
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
}

export interface BackgroundShellExit {
  id: string;
  command: string;
  exitCode: number;
  timedOut: boolean;
  output: string;
  outputTruncated: boolean;
  // Set by the toolset wrapper when truncated output was spilled to the
  // session blob store; the completion message carries the URI.
  spillUri?: string;
}

export type BackgroundShellSnapshot =
  | { state: "running" }
  | { state: "completed"; exit: BackgroundShellExit }
  | { state: "not-found" };

export interface BackgroundShellRegistry {
  start: (args: StartBackgroundShellArgs) => { id: string } | { error: string };
  collect: (
    id: string,
    waitMs?: number,
    signal?: AbortSignal,
  ) => Promise<BackgroundShellSnapshot>;
  cancel: (id: string) => boolean;
  disposeAll: (reason: string) => void;
  releaseWaiters: () => void;
  runningCount: () => number;
}

export function createBackgroundShellRegistry(
  options: { onExit?: (exit: BackgroundShellExit) => void } = {},
): BackgroundShellRegistry {
  const { onExit } = options;
  const running = new Map<string, ChildProcess>();
  const completed = new Map<string, BackgroundShellExit>();
  const exitWaiters = new Map<string, Set<() => void>>();

  const record =
    (id: string, command: string, collector: BoundedShellOutput) =>
    (exitCode: number, timedOut: boolean): void => {
      if (!running.delete(id)) return;
      const { output, truncated } = collector.build();
      const exit: BackgroundShellExit = {
        id,
        command,
        exitCode,
        timedOut,
        output,
        outputTruncated: truncated,
      };
      completed.set(id, exit);
      // Ring eviction drops the oldest completed entry; the completion message
      // already carried a spill URI for truncated output, so nothing is lost.
      while (completed.size > MAX_COMPLETED_BACKGROUND_SHELLS) {
        const oldest = completed.keys().next().value;
        if (oldest === undefined) break;
        completed.delete(oldest);
      }
      const waiters = exitWaiters.get(id);
      if (waiters !== undefined) {
        exitWaiters.delete(id);
        for (const wake of waiters) wake();
      }
      onExit?.(exit);
    };

  const start = (
    args: StartBackgroundShellArgs,
  ): { id: string } | { error: string } => {
    if (running.size >= MAX_RUNNING_BACKGROUND_SHELLS) {
      return {
        error: `background shell limit reached (${MAX_RUNNING_BACKGROUND_SHELLS} running); collect or cancel one first`,
      };
    }
    const id = randomUUID();
    const collector = new BoundedShellOutput(
      args.maxOutputBytes ?? MAX_SHELL_OUTPUT_BYTES,
    );
    // detached so the shell leads a process group and cancel/timeout can
    // SIGKILL the whole tree.
    const child = spawn(args.command, {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      cwd: args.cwd,
      detached: process.platform !== "win32",
      env: args.env !== undefined ? { ...process.env, ...args.env } : undefined,
    });
    running.set(id, child);
    const finish = record(id, args.command, collector);
    child.stdout?.on("data", (chunk: Buffer) => collector.append(chunk));
    child.stderr?.on("data", (chunk: Buffer) => collector.append(chunk));
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (args.timeoutMs !== undefined && args.timeoutMs > 0) {
      timer = setTimeout(() => {
        killProcessTree(child);
        finish(124, true);
      }, args.timeoutMs);
    }
    child.on("error", () => {
      if (timer !== undefined) clearTimeout(timer);
      finish(1, false);
    });
    child.on("close", (code, sig) => {
      if (timer !== undefined) clearTimeout(timer);
      if (!running.has(id)) return;
      finish(code ?? (sig !== null ? 128 : 1), false);
    });
    return { id };
  };

  const collect = async (
    id: string,
    waitMs = 0,
    signal?: AbortSignal,
  ): Promise<BackgroundShellSnapshot> => {
    const done = completed.get(id);
    if (done !== undefined) return { state: "completed", exit: done };
    if (!running.has(id)) return { state: "not-found" };
    if (waitMs > 0) {
      // An already-aborted collect releases immediately as still-running:
      // interrupt must not park the session on a live descendant, and must
      // not kill it either — the child belongs to the still-alive session.
      if (signal?.aborted === true) return { state: "running" };
      // Concurrent collects on the same shell each park their own waiter so
      // they resolve independently: a waiter removes only itself on
      // timeout/abort/settle, never a sibling's registration.
      let wake: (() => void) | undefined;
      const forget = (): void => {
        const waiters = exitWaiters.get(id);
        if (wake !== undefined) waiters?.delete(wake);
        if (waiters !== undefined && waiters.size === 0) exitWaiters.delete(id);
      };
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          forget();
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, waitMs);
        const onAbort = (): void => {
          clearTimeout(timer);
          forget();
          resolve();
        };
        wake = (): void => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        let waiters = exitWaiters.get(id);
        if (waiters === undefined) {
          waiters = new Set();
          exitWaiters.set(id, waiters);
        }
        waiters.add(wake);
      }).finally(() => {
        // Belt-and-braces: record() already dropped the whole entry when it
        // woke us, and timeout/abort self-removed above — this only trims a
        // waiter whose settle path raced out.
        forget();
      });
      const finished = completed.get(id);
      if (finished !== undefined) return { state: "completed", exit: finished };
    }
    return { state: "running" };
  };

  const cancel = (id: string): boolean => {
    const child = running.get(id);
    if (child === undefined) return false;
    killProcessTree(child);
    return true;
  };

  /**
   * Wake every parked `collect` waiter as still-running without touching the
   * children. Interrupt paths call this so a live descendant releases the
   * session instead of wedging teardown; close paths use `disposeAll`, which
   * wakes waiters and then kills the trees.
   */
  const releaseWaiters = (): void => {
    for (const waiters of exitWaiters.values()) {
      for (const wake of waiters) wake();
    }
    exitWaiters.clear();
  };

  const disposeAll = (reason: string): void => {
    for (const child of running.values()) killProcessTree(child);
    running.clear();
    completed.clear();
    releaseWaiters();
    // onExit is intentionally not fired for disposed shells: the session is
    // gone, so there is no later turn to deliver to (`reason` is for callers
    // that log it).
    void reason;
  };

  return {
    start,
    collect,
    cancel,
    disposeAll,
    releaseWaiters,
    runningCount: () => running.size,
  };
}
