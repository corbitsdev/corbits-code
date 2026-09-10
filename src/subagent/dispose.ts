/**
 * Sub-agent session teardown and plugin-spawn visibility for in-flight tools.
 */

import type { ToolPlugin } from "@intx/tools-posix";

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === "string" && reason.length > 0 ? reason : "aborted");
  err.name = "AbortError";
  return err;
}

export { abortError };

export function isSubAgentCancelError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) return true;
  if (err instanceof Error && err.name === "AbortError") return true;
  if (
    typeof DOMException !== "undefined" &&
    err instanceof DOMException &&
    err.name === "AbortError"
  ) {
    return true;
  }
  return false;
}

/** Wall-clock wait for in-flight plugin tool calls to finish before posix dispose. */
export const SUBAGENT_SPAWN_DRAIN_MS = 2_000;

/**
 * Bounded cleanup deadline for close_agent: a wedged descendant's
 * teardown is abandoned (not awaited further), not a reason to hang the
 * caller.
 */
export const DEFAULT_CLOSE_DEADLINE_MS = 30_000;

/**
 * Honest limits for plugin-spawn teardown (for operator docs and output notes).
 * Corbits Code disposes posix tools and LSP sidecars per sub-agent session.
 * Shell-guard tracks live `run_shell` children and kills the process group on
 * plugin dispose (`posixTools.dispose`). Ripgrep detached spawns are not
 * tracked in a global registry.
 */
export const SUBAGENT_PLUGIN_SPAWN_TEARDOWN_LIMITS =
  "Per sub-agent session Corbits Code runs posixTools.dispose() (LSP and plugin dispose callbacks, including in-flight tool drain), then agent.close() and stream drain. " +
  "run_shell children are tracked in the shell-guard plugin and killed on posixTools.dispose; ripgrep detached spawns are not tracked in a global registry.";

/** Fail a hung close instead of resolving as successful teardown. */
export async function awaitBoundedTeardown(
  teardown: Promise<void>,
  deadlineMs: number,
): Promise<void> {
  let teardownError: unknown;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      teardown.then(
        () => undefined,
        (err: unknown) => {
          teardownError = err;
        },
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, deadlineMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (teardownError !== undefined) throw teardownError;
  if (timedOut) throw new Error(`session close exceeded ${deadlineMs}ms`);
}

/**
 * Always start `close`. Await it only when posix/toolset dispose already
 * succeeded; a leftover throw must not wait unbounded on a hung close.
 */
export async function awaitCloseWithoutHidingLeftover(
  close: Promise<unknown>,
  leftover: unknown,
): Promise<void> {
  if (leftover === undefined) {
    await close;
    return;
  }
  void close.then(
    () => undefined,
    () => undefined,
  );
}

export interface SubAgentSpawnSnapshot {
  inFlightToolCalls: number;
  inFlightByTool: Readonly<Record<string, number>>;
}

const PLUGIN_SPAWN_TRACKED_TOOLS = new Set(["run_shell", "grep", "search_files"]);

export interface SubAgentSpawnRegistry {
  plugin: ToolPlugin;
  snapshot: () => SubAgentSpawnSnapshot;
}

/** Middleware plugin: visibility for plugin-layer tool calls that may spawn children. */
export function createSubAgentSpawnRegistryPlugin(): SubAgentSpawnRegistry {
  const inFlight = new Map<string, number>();
  const bump = (name: string, delta: number): void => {
    const next = (inFlight.get(name) ?? 0) + delta;
    if (next <= 0) inFlight.delete(name);
    else inFlight.set(name, next);
  };
  const snapshot = (): SubAgentSpawnSnapshot => {
    let total = 0;
    const byTool: Record<string, number> = {};
    for (const [name, count] of inFlight) {
      total += count;
      byTool[name] = count;
    }
    return { inFlightToolCalls: total, inFlightByTool: byTool };
  };
  const plugin: ToolPlugin = {
    middleware: (next) => async (call, signal) => {
      const track = PLUGIN_SPAWN_TRACKED_TOOLS.has(call.name);
      if (track) bump(call.name, 1);
      try {
        return await next(call, signal);
      } finally {
        if (track) bump(call.name, -1);
      }
    },
    dispose: async () => {
      const deadline = Date.now() + SUBAGENT_SPAWN_DRAIN_MS;
      while (snapshot().inFlightToolCalls > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
  };
  return { plugin, snapshot };
}

export interface SubAgentSessionDisposeInput {
  signal?: AbortSignal | undefined;
  closeOnAbort?: (() => void) | undefined;
  agent: { close(): Promise<void> } | null;
  streamPromise?: Promise<void> | undefined;
  posixTools: { dispose(): Promise<void> };
}

/** Idempotent teardown for one sub-agent loop (completion, error, or cancel). */
export async function disposeSubAgentSession(input: SubAgentSessionDisposeInput): Promise<void> {
  if (input.signal !== undefined && input.closeOnAbort !== undefined) {
    input.signal.removeEventListener("abort", input.closeOnAbort);
  }
  let posixError: unknown;
  try {
    await input.posixTools.dispose();
  } catch (err: unknown) {
    posixError = err;
  }
  try {
    await awaitCloseWithoutHidingLeftover(input.agent?.close() ?? Promise.resolve(), posixError);
  } catch {
    // ignore
  }
  try {
    await awaitCloseWithoutHidingLeftover(input.streamPromise ?? Promise.resolve(), posixError);
  } catch {
    // ignore
  }
  if (posixError !== undefined) throw posixError;
}
