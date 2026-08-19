import { resolve } from "node:path";
import type { ToolPlugin } from "@intx/tools-posix";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { isToolOutputLike } from "../util/tool-output-uri.js";
import { resolveWorkspacePath } from "../permission/path-restriction.js";
import type { RootsProvider } from "../permission/worktree-roots.js";

export type PathEscapeOptions = {
  // When true (yolo / --dangerously-skip-permissions), paths outside the
  // workspace still resolve to absolute form and pass through. Secret-guard and
  // authz remain the hard-deny layers; the permission gate already auto-allows.
  // A getter is resolved per call so `/yolo` mid-session takes effect without
  // rebuilding the plugin stack.
  allowOutside?: boolean | (() => boolean);
};

function resolveAllowOutside(value: boolean | (() => boolean) | undefined): boolean {
  if (typeof value === "function") return value();
  return value === true;
}

export function pathEscapePlugin(
  cwd: string,
  rootsProvider: RootsProvider = () => [],
  options: PathEscapeOptions = {},
): ToolPlugin {
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
        escaped = escapeArgs(
          call.arguments,
          cwd,
          rootsProvider,
          resolveAllowOutside(options.allowOutside),
        );
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
  allowOutside: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && looksLikePath(key)) {
      out[key] = sanitizePath(value, cwd, rootsProvider, allowOutside);
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

function sanitizePath(
  value: string,
  cwd: string,
  rootsProvider: RootsProvider,
  allowOutside: boolean,
): string {
  if (isToolOutputLike(value)) {
    return value;
  }
  const resolved = resolveWorkspacePath(cwd, value, rootsProvider);
  if (resolved !== undefined) {
    return resolved;
  }
  if (allowOutside) {
    // Same lexical resolve as resolveWorkspacePath's in-bounds branch — absolute
    // so later plugins see a stable path, not a relative escape fragment.
    return resolve(cwd, value);
  }
  throw new Error(`Path escapes working directory: ${value}`);
}
