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

/** Plugins under test must install middleware; a missing one fails loudly
 * rather than silently passing through `next`. */
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

// A child whose event order the test dictates, not the platform's pipe-read
// scheduling.
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

// Never emits or closes: the timeout is the only settlement path, no race
// with a real ripgrep's speed.
export const stalledRgSpawn: SpawnRg = (): RgChild => ({
  pid: undefined,
  stdout: { on: () => undefined },
  stderr: { on: () => undefined },
  on: (() => undefined) as RgChild["on"],
  kill: () => undefined,
});
