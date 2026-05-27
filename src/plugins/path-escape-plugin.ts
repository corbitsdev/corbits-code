import { resolve, relative } from "node:path";
import type { ToolPlugin } from "@intx/tools-posix";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

export function pathEscapePlugin(cwd: string): ToolPlugin {
  return {
    middleware: (next) => async (call, signal) => {
      let escaped: Record<string, unknown>;
      try {
        escaped = escapeArgs(call.arguments, cwd);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { callId: call.id, content: message, isError: true };
      }
      return next({ ...call, arguments: escaped }, signal);
    },
  };
}

function escapeArgs(args: Record<string, unknown>, cwd: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && looksLikePath(key)) {
      out[key] = sanitizePath(value, cwd);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function looksLikePath(key: string): boolean {
  return (
    key === "path" ||
    key === "file_path" ||
    key === "target" ||
    key === "cwd" ||
    key === "directory" ||
    key === "dir" ||
    key === "dest" ||
    key === "source" ||
    key === "from" ||
    key === "to" ||
    key === "filename" ||
    key.endsWith("Path")
  );
}

function sanitizePath(value: string, cwd: string): string {
  const resolved = resolve(cwd, value);
  const rel = relative(cwd, resolved);
  if (rel.startsWith("..")) {
    throw new Error(`Path escapes working directory: ${value}`);
  }
  return resolved;
}
