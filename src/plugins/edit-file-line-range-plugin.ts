import type { ToolPlugin } from "@intx/tools-posix";
import { parseEditFileMode, runEditFileLineRange } from "./edit-file-line-range.js";

/**
 * Short-circuits stock tools-posix edit_file for line-range mode (shell-guard pattern).
 */
export function editFileLineRangePlugin(): ToolPlugin {
  return {
    middleware: (next) => async (call, signal) => {
      if (call.name !== "edit_file") {
        return next(call, signal);
      }

      const parsed = parseEditFileMode(call.arguments);
      if (parsed.kind === "invalid") {
        return { callId: call.id, content: parsed.message, isError: true };
      }
      if (parsed.kind === "substring") {
        return next(call, signal);
      }

      try {
        const content = await runEditFileLineRange(parsed, signal);
        return { callId: call.id, content };
      } catch (err) {
        return {
          callId: call.id,
          content: err instanceof Error ? err.message : String(err),
          isError: true,
        };
      }
    },
  };
}
