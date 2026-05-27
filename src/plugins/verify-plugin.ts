import { readFile } from "node:fs/promises";
import type { ToolPlugin } from "@intx/tools-posix";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

export function verifyPlugin(): ToolPlugin {
  return {
    middleware: (next) => async (call, signal) => {
      const result = await next(call, signal);
      if (call.name === "write_file" && !result.isError) {
        const path = String(call.arguments.path ?? "");
        const expected = String(call.arguments.content ?? "");
        try {
          const actual = await readFile(path, "utf8");
          if (actual.length !== expected.length) {
            return {
              callId: call.id,
              content: `Write verification failed: length mismatch (expected ${expected.length}, got ${actual.length})`,
              isError: true,
            };
          }
        } catch (err) {
          return {
            callId: call.id,
            content: `Write verification failed: could not re-read file: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      }
      return result;
    },
  };
}
