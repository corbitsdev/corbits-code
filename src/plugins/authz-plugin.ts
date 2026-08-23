import type { ToolPlugin } from "@intx/tools-posix";
import { runShellAuthzBlockReason } from "../shell/run-shell-authz.js";

export function authzPlugin(): ToolPlugin {
  return {
    middleware: (next) => async (call, signal) => {
      if (call.name === "run_shell") {
        const command = String(call.arguments.command ?? "");
        const reason = runShellAuthzBlockReason(command);
        if (reason !== undefined) {
          return {
            callId: call.id,
            content: reason,
            isError: true,
          };
        }
      }
      return next(call, signal);
    },
  };
}
