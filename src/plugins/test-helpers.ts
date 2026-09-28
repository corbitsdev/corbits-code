import type { ToolCall } from "@intx/types/runtime";
import type { Middleware, ToolHandler, ToolPlugin } from "@intx/tools-posix";

import type { RgChild, SpawnRg } from "./rg-run.js";

export function neverAbort(): AbortSignal {
  return new AbortController().signal;
}

export function makeToolCall(
  name: string,
  args: Record<string, unknown>,
): ToolCall {
  return { id: "test-call", name, arguments: args };
}

export const okHandler: ToolHandler = async (call) => ({
  callId: call.id,
  content: "ok",
});

/** Terminal handler that echoes the (possibly middleware-rewritten) arguments. */
export const echoArgsHandler: ToolHandler = async (call) => ({
  callId: call.id,
  content: JSON.stringify(call.arguments),
});

/**
 * The plugin under test is expected to install middleware; a missing one must
 * fail loudly rather than silently pass through `next`.
 */
export function middlewareOf(plugin: ToolPlugin): Middleware {
  if (plugin.middleware === undefined) {
    throw new Error("expected middleware");
  }
  return plugin.middleware;
}

export function pluginHandler(
  plugin: ToolPlugin,
  next: ToolHandler,
): ToolHandler {
  return middlewareOf(plugin)(next);
}

/** The canonical start_line/end_line edit_file call shape. */
export function lineRangeEditCall(path: string, id = "call-1"): ToolCall {
  return {
    id,
    name: "edit_file",
    arguments: { path, start_line: 2, end_line: 2, new_string: "B" },
  };
}

export interface RgScript {
  stdout: string[];
  code: number | null;
  /** When true, fire close before any stdout data (Linux-style race). */
  closeFirst?: boolean;
}

// A child whose event order is dictated by the test rather than by how the
// platform happens to schedule pipe reads.
export function scriptedRgSpawn(script: RgScript): SpawnRg {
  return () => {
    let onData: ((chunk: unknown) => void) | undefined;
    let onClose: ((code: number | null) => void) | undefined;
    const child: RgChild = {
      pid: undefined,
      stdout: {
        on: (_event, listener) => {
          onData = listener;
        },
      },
      stderr: { on: () => undefined },
      on: ((event: string, listener: (arg: never) => void) => {
        if (event === "close")
          onClose = listener as (code: number | null) => void;
      }) as RgChild["on"],
      kill: () => undefined,
    };
    queueMicrotask(() => {
      if (script.closeFirst) {
        onClose?.(script.code);
        script.stdout.forEach((chunk) => onData?.(chunk));
      } else {
        script.stdout.forEach((chunk) => onData?.(chunk));
        onClose?.(script.code);
      }
    });
    return child;
  };
}

// A child that never emits data or closes, so the timeout is the only path
// to settlement — no race against how fast a real ripgrep happens to run.
export const stalledRgSpawn: SpawnRg = (): RgChild => ({
  pid: undefined,
  stdout: { on: () => undefined },
  stderr: { on: () => undefined },
  on: (() => undefined) as RgChild["on"],
  kill: () => undefined,
});
