import type { ToolPlugin } from "@intx/tools-posix";
import type { PermissionGate } from "../permission/gate.js";

// Gate consequential tool calls on operator approval. Runs after the
// authorization plugin (which hard-denies catastrophic commands), so by the time
// a call reaches here it is at worst "consequential but legitimate" — the gate
// either finds it pre-approved, asks the operator, or denies it in headless runs.
export function permissionPlugin(gate: PermissionGate): ToolPlugin {
  return {
    middleware: (next) => async (call, signal) => {
      const verdict = await gate.evaluate(call);
      if (!verdict.allowed) {
        return { callId: call.id, content: `Blocked by permission policy: ${verdict.reason}`, isError: true };
      }
      return next(call, signal);
    },
  };
}
