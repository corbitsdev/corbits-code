import type { ToolPlugin } from "@intx/tools-posix";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { isToolOutputLike } from "../util/tool-output-uri.js";
import { resolveWorkspacePath } from "../permission/path-restriction.js";
import type { RootsProvider } from "../permission/worktree-roots.js";

export function pathEscapePlugin(cwd: string, rootsProvider: RootsProvider = () => []): ToolPlugin {
  return {
    middleware: (next) => async (call, signal) => {
      if ("_raw" in call.arguments) {
        return {
          callId: call.id,
          content: "Tool call arguments were malformed JSON (likely truncated). Retry with a smaller payload.",
          isError: true,
        };
      }
      let escaped: Record<string, unknown>;
      try {
        escaped = escapeArgs(call.arguments, cwd, rootsProvider);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { callId: call.id, content: message, isError: true };
      }
      return next({ ...call, arguments: escaped }, signal);
    },
  };
}

function escapeArgs(
  args: Record<string, unknown>,
  cwd: string,
  rootsProvider: RootsProvider,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && looksLikePath(key)) {
      out[key] = sanitizePath(value, cwd, rootsProvider);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function looksLikePath(key: string): boolean {
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

function sanitizePath(value: string, cwd: string, rootsProvider: RootsProvider): string {
  if (isToolOutputLike(value)) {
    return value;
  }
  const resolved = resolveWorkspacePath(cwd, value, rootsProvider);
  if (resolved === undefined) {
    throw new Error(`Path escapes working directory: ${value}`);
  }
  return resolved;
}
