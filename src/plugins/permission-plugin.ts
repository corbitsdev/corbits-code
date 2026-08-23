import type { ToolPlugin } from "@intx/tools-posix";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import type { PermissionGate } from "../permission/gate.js";

// Run a tool call past the gate, invoking `next` only if it is allowed. Shared by
// the posix middleware and the late-connected MCP tools (which are not part of
// the posix runner the middleware wraps) so both produce the same denial result.
export async function gateToolCall(
  gate: PermissionGate,
  call: ToolCall,
  signal: AbortSignal,
  next: (call: ToolCall, signal: AbortSignal) => Promise<ToolResult>,
): Promise<ToolResult> {
  const verdict = await gate.evaluate(call);
  if (!verdict.allowed) {
    return {
      callId: call.id,
      content: `Blocked by permission policy: ${verdict.reason}`,
      isError: true,
    };
  }
  return next(call, signal);
}

// Gate consequential tool calls on operator approval. Runs after the
// authorization plugin (which hard-denies catastrophic commands), so by the time
// a call reaches here it is at worst "consequential but legitimate" — the gate
// either finds it pre-approved, asks the operator, or denies it in headless runs.
export function permissionPlugin(gate: PermissionGate): ToolPlugin {
  return {
    middleware: (next) => (call, signal) => gateToolCall(gate, call, signal, next),
  };
}
