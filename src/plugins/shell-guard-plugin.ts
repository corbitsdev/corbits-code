import { spawn, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import type { ToolPlugin } from "@intx/tools-posix";
import { formatSearchTimeoutMessage, TIMEOUT_PREFIX } from "./tool-time-budget.js";
import { BUDGET_EXPIRED, budgetExpiry, withTimeout } from "../util/budget-race.js";
import type { ToolDefinition } from "@intx/types/runtime";
import {
  assertShellCwdUsable,
  isShellCwdWithinSession,
  parsePwdProbeOutput,
  resolvePerCallShellCwd,
  shellCwdEscapesSessionMessage,
  wrapCommandWithPwdProbe,
} from "../shell/persistent-shell-cwd.js";

// Corbits Code-side replacement for stock `@intx/tools-posix` run_shell.
// We do not patch interchange: this middleware short-circuits run_shell and
// enforces an optional timeout (no built-in default — match Pi), an
// output-byte cap, and process-group kill so open-ended walks cannot OOM the host.

export const MAX_SHELL_OUTPUT_BYTES = 512_000;

export interface ShellTimeoutConfig {
  defaultMs?: number;
  maxMs?: number;
  maxOutputBytes?: number;
}

/**
 * Effective run_shell timeout. Omitting `requested` (or a non-positive value)
 * uses `defaultMs` when set; otherwise returns undefined (no timer). `maxMs`
 * clamps only a resolved timeout — it alone does not invent one. There is no
 * implicit 10-minute ceiling and no built-in 15s/2m default.
 */
export function resolveShellTimeoutMs(
  requested: number | undefined,
  defaultMs: number | undefined,
  maxMs?: number,
): number | undefined {
  const fromRequest = requested !== undefined && requested > 0 ? requested : undefined;
  const fromDefault = defaultMs !== undefined && defaultMs > 0 ? defaultMs : undefined;
  const base = fromRequest ?? fromDefault;
  if (base === undefined) return undefined;
  if (maxMs === undefined) return base;
  return Math.min(base, maxMs);
}

/**
 * Stock tools-posix still advertises timeout default 30000. Shell-guard has no
 * built-in default; rewrite the definition the model sees so schema and behavior
 * agree. When settings supply defaultMs, advertise that. Corbits Code-only —
 * does not patch interchange.
 */
export function advertiseShellGuardTimeout(
  definition: ToolDefinition,
  defaultMs?: number,
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
    const hasDefault = defaultMs !== undefined && defaultMs > 0;
    nextProperties["timeout"] = {
      ...(timeout as Record<string, unknown>),
      description: hasDefault
        ? `Timeout in milliseconds (default: ${defaultMs})`
        : "Timeout in milliseconds (optional; omit for no default timeout)",
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

interface RunShellArgs {
  command: string;
  timeout?: number;
  cwd?: string;
  maxOutputBytes?: number;
  env?: Record<string, string>;
}

export interface GuardedShellResult {
  output: string;
  exitCode: number;
  timedOut: boolean;
  outputTruncated: boolean;
}

/**
 * Collects shell stdout/stderr with a hard byte ceiling. While under the cap the
 * stream is buffered whole; beyond it only the first and last slices are kept
 * (head+tail) so RSS stays bounded and the agent still sees start/end of output.
 */
export class BoundedShellOutput {
  private readonly headMax: number;
  private readonly tailMax: number;
  private mode: "buffering" | "truncating" = "buffering";
  private buffered: Buffer[] = [];
  private head = Buffer.alloc(0);
  private tailChunks: Buffer[] = [];
  private tailBytes = 0;
  totalBytes = 0;

  constructor(private readonly maxBytes: number) {
    const markerReserve = Math.min(256, Math.floor(this.maxBytes * 0.15));
    const body = Math.max(8, this.maxBytes - markerReserve);
    this.headMax = Math.floor(body / 2);
    this.tailMax = body - this.headMax;
  }

  append(chunk: Buffer): boolean {
    this.totalBytes += chunk.length;
    if (this.mode === "buffering") {
      this.buffered.push(chunk);
      if (this.totalBytes <= this.maxBytes) return false;
      this.enterTruncating();
      return true;
    }
    this.pushHeadTail(chunk);
    return true;
  }

  private enterTruncating(): void {
    this.mode = "truncating";
    const all = Buffer.concat(this.buffered);
    this.buffered = [];
    this.head = all.subarray(0, Math.min(all.length, this.headMax));
    const rest = all.subarray(this.head.length);
    if (rest.length > 0) this.pushTail(rest);
  }

  private pushHeadTail(chunk: Buffer): void {
    let rest = chunk;
    if (this.head.length < this.headMax) {
      const take = Math.min(rest.length, this.headMax - this.head.length);
      this.head = Buffer.concat([this.head, rest.subarray(0, take)]);
      rest = rest.subarray(take);
    }
    if (rest.length > 0) this.pushTail(rest);
  }

  private pushTail(buf: Buffer): void {
    this.tailChunks.push(buf);
    this.tailBytes += buf.length;
    while (this.tailBytes > this.tailMax && this.tailChunks.length > 0) {
      const first = this.tailChunks[0]!;
      if (this.tailBytes - first.length >= this.tailMax) {
        this.tailBytes -= first.length;
        this.tailChunks.shift();
      } else {
        const drop = this.tailBytes - this.tailMax;
        this.tailChunks[0] = first.subarray(drop);
        this.tailBytes -= drop;
        break;
      }
    }
  }

  build(): { output: string; truncated: boolean } {
    if (this.mode === "buffering") {
      return {
        output: Buffer.concat(this.buffered).toString("utf8"),
        truncated: false,
      };
    }
    const tail = Buffer.concat(this.tailChunks);
    const omitted = Math.max(0, this.totalBytes - this.head.length - tail.length);
    const marker =
      `\n\n[command output truncated — ${omitted.toLocaleString()} bytes omitted from this view; ` +
      `head+tail retained under ${this.maxBytes.toLocaleString()} byte cap. ` +
      `Full output is not lost: re-run with stdout redirected to a workspace file, then read_file or grep that path.]\n\n`;
    return {
      output: this.head.toString("utf8") + marker + tail.toString("utf8"),
      truncated: true,
    };
  }
}

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
): Promise<GuardedShellResult> {
  signal.throwIfAborted();

  // Arm setTimeout only when a positive timeout was resolved. No built-in default.
  const timeoutMs = args.timeout !== undefined && args.timeout > 0 ? args.timeout : undefined;
  const outputCap = args.maxOutputBytes ?? MAX_SHELL_OUTPUT_BYTES;
  const collector = new BoundedShellOutput(outputCap);

  return new Promise((resolve, reject) => {
    // detached so the shell becomes a process-group leader and timeout/abort
    // can SIGKILL the whole tree (otherwise find/grep orphans keep burning RAM).
    const child = spawn(args.command, {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      cwd: args.cwd,
      detached: process.platform !== "win32",
      // Inherits process.env (node_child_process default) plus any per-project
      // settings.env overrides layered on top.
      env: args.env !== undefined ? { ...process.env, ...args.env } : undefined,
    });

    if (child.stdout === null || child.stderr === null) {
      reject(new Error("child process streams are null; stdio misconfigured"));
      return;
    }

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const clearTimer = () => {
      if (timer !== undefined) clearTimeout(timer);
    };

    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimer();
      abortCleanup();
      if (err !== undefined) {
        reject(err);
      }
    };

    const finishOutput = (exitCode: number, timedOut: boolean) => {
      if (settled) return;
      settled = true;
      clearTimer();
      abortCleanup();
      const { output, truncated } = collector.build();
      resolve({
        output,
        exitCode,
        timedOut,
        outputTruncated: truncated,
      });
    };

    const onChunk = (chunk: Buffer) => {
      if (settled) return;
      // Switch to head+tail collection when over cap; keep the process running so
      // the command can finish and its true exit code is preserved.
      collector.append(chunk);
    };

    // Interleave stdout and stderr in arrival order into one collector.
    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);

    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        killProcessTree(child);
        // A timeout is not a failure the agent should be denied output for: return
        // whatever the command produced before the kill, plus the timed-out notice
        // the caller appends from `timedOut`.
        finishOutput(124, true);
      }, timeoutMs);
    }

    const onAbort = () => {
      killProcessTree(child);
      settle(new Error(`command aborted: ${args.command}`));
    };

    signal.addEventListener("abort", onAbort, { once: true });

    const abortCleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };

    child.on("error", (err) => {
      settle(new Error(`failed to spawn command: ${args.command}`, { cause: err }));
    });

    child.on("close", (code, sig) => {
      if (settled) return;
      const exitCode = code ?? (sig !== null ? 128 : 1);
      finishOutput(exitCode, false);
    });
  });
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Replaces stock run_shell with a hard-capped implementation, and applies a
 * 10s wall-clock budget to grep/search_files when the agent does not abort
 * earlier. Does not modify interchange — short-circuits before the base tool.
 */
export interface ShellGuardPluginOptions {
  // When true (yolo / --dangerously-skip-permissions), shell may retain a cwd
  // outside the session root. A getter is resolved per call so `/yolo`
  // mid-session takes effect without rebuilding the plugin stack.
  allowOutsideCwd?: boolean | (() => boolean);
}

function resolveAllowOutsideCwd(value: boolean | (() => boolean) | undefined): boolean {
  if (typeof value === "function") return value();
  return value === true;
}

export function shellGuardPlugin(
  cwd: string,
  timeoutConfig?: ShellTimeoutConfig,
  env?: Record<string, string>,
  options: ShellGuardPluginOptions = {},
): ToolPlugin {
  // No built-in default — only settings.shell.timeoutMs (or a per-call timeout)
  // arms a timer. maxMs alone does not invent one.
  const defaultMs = timeoutConfig?.defaultMs;
  const maxOutputBytes = timeoutConfig?.maxOutputBytes ?? MAX_SHELL_OUTPUT_BYTES;
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
          const allowOutsideCwd = resolveAllowOutsideCwd(options.allowOutsideCwd);
          let executionCwd = retainedShellCwd;
          if (perCallCwdRaw !== undefined) {
            try {
              executionCwd = resolvePerCallShellCwd(sessionRoot, perCallCwdRaw, {
                allowOutsideSession: allowOutsideCwd,
              });
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
          const effectiveTimeout = resolveShellTimeoutMs(
            requested,
            defaultMs,
            timeoutConfig?.maxMs,
          );
          const wrappedCommand = wrapCommandWithPwdProbe(command);
          try {
            const { output, exitCode, timedOut, outputTruncated } = await runGuardedShell(
              {
                command: wrappedCommand,
                cwd: executionCwd,
                ...(effectiveTimeout !== undefined ? { timeout: effectiveTimeout } : {}),
                maxOutputBytes,
                ...(env !== undefined ? { env } : {}),
              },
              signal,
            );
            const parsed = parsePwdProbeOutput(output);
            if (perCallCwdRaw === undefined && parsed.finalCwd !== undefined) {
              if (!allowOutsideCwd && !isShellCwdWithinSession(sessionRoot, parsed.finalCwd)) {
                return {
                  callId: call.id,
                  content: shellCwdEscapesSessionMessage(parsed.finalCwd),
                  isError: true,
                };
              }
              retainedShellCwd = parsed.finalCwd;
            }
            const base = exitCode === 0 ? parsed.output : `exit code ${exitCode}\n${parsed.output}`;
            let content = base;
            if (outputTruncated) {
              content =
                `${base}${base.length > 0 ? "\n" : ""}` +
                `[command output exceeded the display byte cap; the process was not killed. ` +
                `Capture full output by redirecting to a file in the workspace, then read_file or grep.]`;
            }
            if (timedOut) {
              content = `${content}${content.length > 0 ? "\n" : ""}[command timed out after ${effectiveTimeout}ms and was terminated]`;
            }
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
              : formatSearchTimeoutMessage(call.name as "grep" | "search_files");
            return { callId: call.id, content, isError: true };
          }

          if (
            outcome.isError === true &&
            typeof outcome.content === "string" &&
            outcome.content.includes(TIMEOUT_PREFIX)
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
              content: formatSearchTimeoutMessage(call.name as "grep" | "search_files"),
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
