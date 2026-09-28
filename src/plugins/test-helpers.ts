import type { ToolCall } from "@intx/types/runtime";
import type { Middleware, ToolHandler, ToolPlugin } from "@intx/tools-posix";

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
