import type { ToolPlugin } from "@intx/tools-posix";
import {
  parseEditFileMode,
  runEditFileLineRange,
} from "./edit-file-line-range.js";
import { denyResult, errorMessage } from "./tool-args.js";

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
        return denyResult(call.id, parsed.message);
      }
      if (parsed.kind === "substring") {
        return next(call, signal);
      }

      try {
        const content = await runEditFileLineRange(parsed, signal);
        return { callId: call.id, content };
      } catch (err) {
        return denyResult(call.id, errorMessage(err));
      }
    },
  };
}
