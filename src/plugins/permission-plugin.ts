import type { ToolPlugin } from "@intx/tools-posix";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import type { PermissionGate } from "../permission/gate.js";

// Run a tool call past the gate, invoking `next` only if it is allowed. Shared by
// the posix middleware and the late-connected MCP tools (which are not part of
// the posix runner the middleware wraps) so both produce the same denial result.
//
// Under reactor gating the bypass is unconditional: the reactor's before-tool
// authz hook already ran this gate's policy (evaluate and authorizeCall share
// one decide), and an approved re-dispatch arrives here with the one-shot
// bypass consumed — a second gate would re-ask the operator for a call the
// reactor already approved.
export async function gateToolCall(
  gate: PermissionGate,
  call: ToolCall,
  signal: AbortSignal,
  next: (call: ToolCall, signal: AbortSignal) => Promise<ToolResult>,
): Promise<ToolResult> {
  if (gate.isReactorGated()) {
    return next(call, signal);
  }
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
