import { spawn, type ChildProcess } from "node:child_process";
import type { ToolPlugin } from "@intx/tools-posix";

// Intercode-side replacement for stock `@intx/tools-posix` run_shell.
// We do not patch interchange: this middleware short-circuits run_shell and
// enforces a short default timeout, an output-byte cap, and process-group kill
// so open-ended walks cannot OOM the host.

export const DEFAULT_SHELL_TIMEOUT_MS = 10_000;
export const MAX_SHELL_OUTPUT_BYTES = 512_000;

// Search tools that can walk large trees; cap them even when the agent forgets.
const SEARCH_TOOL_TIMEOUT_MS = 10_000;
const SEARCH_TOOLS = new Set(["grep", "search_files"]);

type RunShellArgs = {
  command: string;
  timeout?: number;
  cwd?: string;
};

function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      child.kill("SIGKILL");
    } else {
      // Negative PID signals the whole process group. With detached:true the
      // shell is the group leader, so grandchildren (find, grep, …) die too.
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

export async function runGuardedShell(
  args: RunShellArgs,
  signal: AbortSignal,
): Promise<{ output: string; exitCode: number }> {
  signal.throwIfAborted();

  const timeoutMs = args.timeout ?? DEFAULT_SHELL_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    let totalBytes = 0;

    // detached so the shell becomes a process-group leader and timeout/abort
    // can SIGKILL the whole tree (otherwise find/grep orphans keep burning RAM).
    const child = spawn(args.command, {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      cwd: args.cwd,
      detached: process.platform !== "win32",
    });

    if (child.stdout === null || child.stderr === null) {
      reject(new Error("child process streams are null; stdio misconfigured"));
      return;
    }

    let settled = false;

    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortCleanup();
      if (err !== undefined) {
        reject(err);
      }
    };

    const onChunk = (chunk: Buffer) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_SHELL_OUTPUT_BYTES) {
        killProcessTree(child);
        settle(
          new Error(
            `command output exceeded ${MAX_SHELL_OUTPUT_BYTES} bytes (killed): ${args.command}`,
          ),
        );
        return;
      }
      chunks.push(chunk.toString("utf8"));
    };

    // Interleave stdout and stderr in arrival order into one collector.
    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);

    const timer = setTimeout(() => {
      killProcessTree(child);
      settle(
        new Error(`command timed out after ${timeoutMs}ms: ${args.command}`),
      );
    }, timeoutMs);

    const onAbort = () => {
      killProcessTree(child);
      settle(new Error(`command aborted: ${args.command}`));
    };

    signal.addEventListener("abort", onAbort, { once: true });

    const abortCleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };

    child.on("error", (err) => {
      settle(
        new Error(`failed to spawn command: ${args.command}`, { cause: err }),
      );
    });

    child.on("close", (code, sig) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortCleanup();

      const output = chunks.join("");
      const exitCode = code ?? (sig !== null ? 128 : 1);
      resolve({ output, exitCode });
    });
  });
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function withTimeout(
  signal: AbortSignal,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  signal.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal.aborted) controller.abort();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onParentAbort);
    },
  };
}

/**
 * Replaces stock run_shell with a hard-capped implementation, and applies a
 * 10s wall-clock budget to grep/search_files when the agent does not abort
 * earlier. Does not modify interchange — short-circuits before the base tool.
 */
export function shellGuardPlugin(cwd: string): ToolPlugin {
  return {
    middleware: (next) => async (call, signal) => {
      if (call.name === "run_shell") {
        const command = call.arguments.command;
        if (typeof command !== "string" || command.length === 0) {
          return {
            callId: call.id,
            content: 'argument "command" is required',
            isError: true,
          };
        }
        const timeout = optionalNumber(call.arguments.timeout);
        try {
          const { output, exitCode } = await runGuardedShell(
            {
              command,
              cwd,
              ...(timeout !== undefined ? { timeout } : {}),
            },
            signal,
          );
          const content =
            exitCode === 0 ? output : `exit code ${exitCode}\n${output}`;
          return { callId: call.id, content };
        } catch (err) {
          return {
            callId: call.id,
            content: err instanceof Error ? err.message : String(err),
            isError: true,
          };
        }
      }

      if (SEARCH_TOOLS.has(call.name)) {
        const budget = withTimeout(signal, SEARCH_TOOL_TIMEOUT_MS);
        try {
          const result = await next(call, budget.signal);
          // If we aborted on budget and the base tool returned a generic abort,
          // surface a clearer timeout message.
          if (
            budget.signal.aborted &&
            !signal.aborted &&
            result.isError === true &&
            typeof result.content === "string" &&
            /abort/i.test(result.content)
          ) {
            return {
              callId: call.id,
              content: `${call.name} timed out after ${SEARCH_TOOL_TIMEOUT_MS}ms — narrow path/glob`,
              isError: true,
            };
          }
          return result;
        } finally {
          budget.dispose();
        }
      }

      return next(call, signal);
    },
  };
}
