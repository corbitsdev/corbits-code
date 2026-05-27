import type { ToolPlugin } from "@intx/tools-posix";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\//,
  />\s*\/etc\//,
  /dd\s+if=/,
  /mkfs\./,
  /:\(\)\s*\{\s*:\|:\&\s*\};/,
];

export function authzPlugin(): ToolPlugin {
  return {
    middleware: (next) => async (call, signal) => {
      if (call.name === "run_shell") {
        const command = String(call.arguments.command ?? "");
        for (const pattern of BLOCKED_PATTERNS) {
          if (pattern.test(command)) {
            return {
              callId: call.id,
              content: `Destructive command blocked by policy: ${command}`,
              isError: true,
            };
          }
        }
      }
      return next(call, signal);
    },
  };
}
