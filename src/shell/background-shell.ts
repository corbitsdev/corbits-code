import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  BoundedShellOutput,
  MAX_SHELL_OUTPUT_BYTES,
} from "../plugins/shell-guard-plugin.js";

// Background run_shell: start returns a handle at once and the process keeps
// running past the end of the turn, so queued steers land while builds and dev
// servers run. On exit the result is delivered to the host via onExit as a
// system message on a later turn; stop=<id> cancels by id.

export const MAX_RUNNING_BACKGROUND_SHELLS = 8;
// Prefer close so trailing stdio is captured, but never require it: a grandchild
// holding the pipe must not delay the completion message after the child exits.
const STDIO_DRAIN_MS = 100;

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

export interface BackgroundShellRegistry {
  start: (args: StartBackgroundShellArgs) => { id: string } | { error: string };
  cancel: (id: string) => boolean;
  disposeAll: (reason: string) => void;
  runningCount: () => number;
}

export function createBackgroundShellRegistry(
  options: { onExit?: (exit: BackgroundShellExit) => void } = {},
): BackgroundShellRegistry {
  const { onExit } = options;
  const running = new Map<string, ChildProcess>();

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
      onExit?.(exit);
    };

  const start = (
    args: StartBackgroundShellArgs,
  ): { id: string } | { error: string } => {
    if (running.size >= MAX_RUNNING_BACKGROUND_SHELLS) {
      return {
        error: `background shell limit reached (${MAX_RUNNING_BACKGROUND_SHELLS} running); stop one first`,
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
    // Clearing an unset timer is a no-op, so one unguarded closure covers
    // every settle path below.
    const clearTimer = (): void => clearTimeout(timer);
    // Per-call timeout only — background has no 120s default.
    if (args.timeoutMs !== undefined && args.timeoutMs > 0) {
      timer = setTimeout(() => {
        killProcessTree(child);
        finish(124, true);
      }, args.timeoutMs);
    }
    child.on("error", () => {
      clearTimer();
      finish(1, false);
    });
    child.on("exit", (code, sig) => {
      clearTimer();
      if (!running.has(id)) return;
      const exitCode = code ?? (sig !== null ? 128 : 1);
      const settle = (): void => finish(exitCode, false);
      const grace = setTimeout(settle, STDIO_DRAIN_MS);
      child.once("close", () => {
        clearTimeout(grace);
        settle();
      });
    });
    return { id };
  };

  const cancel = (id: string): boolean => {
    const child = running.get(id);
    if (child === undefined) return false;
    killProcessTree(child);
    return true;
  };

  const disposeAll = (reason: string): void => {
    for (const child of running.values()) killProcessTree(child);
    running.clear();
    // No onExit for disposed shells: the session is gone, so there is no later
    // turn to deliver to.
    void reason;
  };

  return {
    start,
    cancel,
    disposeAll,
    runningCount: () => running.size,
  };
}
