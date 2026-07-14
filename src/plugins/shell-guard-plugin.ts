import { spawn, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import type { ToolPlugin } from "@intx/tools-posix";
import { formatSearchTimeoutMessage } from "./tool-time-budget.js";
import type { ToolDefinition } from "@intx/types/runtime";
import {
  assertShellCwdUsable,
  isShellCwdWithinSession,
  parsePwdProbeOutput,
  resolvePerCallShellCwd,
  shellCwdEscapesSessionMessage,
  wrapCommandWithPwdProbe,
} from "../shell/persistent-shell-cwd.js";

// Intercode-side replacement for stock `@intx/tools-posix` run_shell.
// We do not patch interchange: this middleware short-circuits run_shell and
// enforces a short default timeout, an output-byte cap, and process-group kill
// so open-ended walks cannot OOM the host.

export const DEFAULT_SHELL_TIMEOUT_MS = 15_000;
// Upper bound on a per-command timeout override, so the model cannot ask for an
// effectively unbounded wait. Configurable via settings.
export const MAX_SHELL_TIMEOUT_MS = 600_000;
export const MAX_SHELL_OUTPUT_BYTES = 512_000;

export type ShellTimeoutConfig = { defaultMs?: number; maxMs?: number };

/**
 * Stock tools-posix still advertises timeout default 30000. Shell-guard enforces
 * 15s default; rewrite the definition the model sees so schema and behavior agree.
 * Intercode-only — does not patch interchange.
 */
export function advertiseShellGuardTimeout(
  definition: ToolDefinition,
  defaultMs: number = DEFAULT_SHELL_TIMEOUT_MS,
): ToolDefinition {
  if (definition.name !== "run_shell") return definition;
  const schema = definition.inputSchema;
  const props = schema["properties"];
  if (props === undefined || typeof props !== "object" || props === null) {
    return definition;
  }
  const properties = props as Record<string, unknown>;
  const timeout = properties["timeout"];
  const cwdProp = properties["cwd"];
  const nextProperties = { ...properties };
  if (timeout !== undefined && typeof timeout === "object" && timeout !== null) {
    nextProperties["timeout"] = {
      ...(timeout as Record<string, unknown>),
      description: `Timeout in milliseconds (default: ${defaultMs})`,
    };
  }
  if (cwdProp === undefined) {
    nextProperties["cwd"] = {
      type: "string",
      description:
        "Optional working directory for this call only (does not change the session shell cwd retained across calls)",
    };
  }
  return {
    ...definition,
    inputSchema: {
      ...schema,
      properties: nextProperties,
    },
  };
}

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
): Promise<{ output: string; exitCode: number; timedOut: boolean }> {
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
      // A timeout is not a failure the agent should be denied output for: return
      // whatever the command produced before the kill, plus the timed-out notice
      // the caller appends from `timedOut`.
      if (settled) return;
      settled = true;
      abortCleanup();
      resolve({ output: chunks.join(""), exitCode: 124, timedOut: true });
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
      resolve({ output, exitCode, timedOut: false });
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

const BUDGET_EXPIRED = Symbol("search-budget-expired");

function budgetExpiry(signal: AbortSignal): Promise<typeof BUDGET_EXPIRED> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(BUDGET_EXPIRED);
      return;
    }
    signal.addEventListener("abort", () => resolve(BUDGET_EXPIRED), {
      once: true,
    });
  });
}

/**
 * Replaces stock run_shell with a hard-capped implementation, and applies a
 * 10s wall-clock budget to grep/search_files when the agent does not abort
 * earlier. Does not modify interchange — short-circuits before the base tool.
 */
export function shellGuardPlugin(
  cwd: string,
  timeoutConfig?: ShellTimeoutConfig,
): ToolPlugin {
  const defaultMs = timeoutConfig?.defaultMs ?? DEFAULT_SHELL_TIMEOUT_MS;
  const maxMs = timeoutConfig?.maxMs ?? MAX_SHELL_TIMEOUT_MS;
  const sessionRoot = realpathSync(cwd);
  let retainedShellCwd = sessionRoot;
  // Serialize run_shell so concurrent tools cannot race retained cwd updates
  // (last-writer-wins or a non-cd call finishing after a cd and resetting cwd).
  let shellChain: Promise<unknown> = Promise.resolve();
  const enqueueShell = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = shellChain.then(fn, fn);
    shellChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  return {
    middleware: (next) => async (call, signal) => {
      if (call.name === "run_shell") {
        return enqueueShell(async () => {
          const command = call.arguments.command;
          if (typeof command !== "string" || command.length === 0) {
            return {
              callId: call.id,
              content: 'argument "command" is required',
              isError: true,
            };
          }
          const perCallCwdRaw =
            typeof call.arguments.cwd === "string" && call.arguments.cwd.length > 0
              ? call.arguments.cwd
              : undefined;
          let executionCwd = retainedShellCwd;
          if (perCallCwdRaw !== undefined) {
            try {
              executionCwd = resolvePerCallShellCwd(sessionRoot, perCallCwdRaw);
            } catch (err) {
              return {
                callId: call.id,
                content: err instanceof Error ? err.message : String(err),
                isError: true,
              };
            }
          }
          try {
            assertShellCwdUsable(executionCwd);
          } catch (err) {
            return {
              callId: call.id,
              content: err instanceof Error ? err.message : String(err),
              isError: true,
            };
          }
          const requested = optionalNumber(call.arguments.timeout);
          const baseTimeoutMs =
            requested !== undefined && requested > 0 ? requested : defaultMs;
          const effectiveTimeout = Math.min(baseTimeoutMs, maxMs);
          const wrappedCommand = wrapCommandWithPwdProbe(command);
          try {
            const { output, exitCode, timedOut } = await runGuardedShell(
              { command: wrappedCommand, cwd: executionCwd, timeout: effectiveTimeout },
              signal,
            );
            const parsed = parsePwdProbeOutput(output);
            if (perCallCwdRaw === undefined && parsed.finalCwd !== undefined) {
              if (!isShellCwdWithinSession(sessionRoot, parsed.finalCwd)) {
                return {
                  callId: call.id,
                  content: shellCwdEscapesSessionMessage(parsed.finalCwd),
                  isError: true,
                };
              }
              retainedShellCwd = parsed.finalCwd;
            }
            const base =
              exitCode === 0 ? parsed.output : `exit code ${exitCode}\n${parsed.output}`;
            const content = timedOut
              ? `${base}${base.length > 0 ? "\n" : ""}[command timed out after ${effectiveTimeout}ms and was terminated]`
              : base;
            return { callId: call.id, content };
          } catch (err) {
            return {
              callId: call.id,
              content: err instanceof Error ? err.message : String(err),
              isError: true,
            };
          }
        });
      }

      if (SEARCH_TOOLS.has(call.name)) {
        const budget = withTimeout(signal, SEARCH_TOOL_TIMEOUT_MS);
        try {
          // Race the downstream handler against the budget rather than awaiting
          // it. The fallback grep performs a non-abortable recursive readdir, so
          // aborting its signal does not stop the walk; without the race a host
          // without ripgrep could burn the loop far past the wall-clock budget.
          const outcome = await Promise.race([
            next(call, budget.signal),
            budgetExpiry(budget.signal),
          ]);

          if (outcome === BUDGET_EXPIRED) {
            const content = signal.aborted
              ? `${call.name} aborted`
              : formatSearchTimeoutMessage(
                  call.name as "grep" | "search_files",
                );
            return { callId: call.id, content, isError: true };
          }

          if (
            outcome.isError === true &&
            typeof outcome.content === "string" &&
            outcome.content.includes("[timed out before completing]")
          ) {
            return outcome;
          }

          // The base tool honored the abort and returned a generic abort error;
          // surface a clearer timeout message when the budget, not the parent,
          // triggered it.
          if (
            budget.signal.aborted &&
            !signal.aborted &&
            outcome.isError === true &&
            typeof outcome.content === "string" &&
            /abort/i.test(outcome.content)
          ) {
            return {
              callId: call.id,
              content: formatSearchTimeoutMessage(
                call.name as "grep" | "search_files",
              ),
              isError: true,
            };
          }
          return outcome;
        } finally {
          budget.dispose();
        }
      }

      return next(call, signal);
    },
  };
}
