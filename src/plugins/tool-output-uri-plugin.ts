import type { ToolPlugin } from "@intx/tools-posix";
import { isToolOutputLike, normalizeToolOutputUri } from "../util/tool-output-uri.js";

/**
 * Normalize read_file tool-output URIs before the posix handler or read-file
 * guard resolves blobs. Every other tool that takes a `path` argument (grep,
 * search_files, ...) rejects the scheme here, before it reaches ripgrep or
 * the filesystem — those tools have no blob reader and would otherwise treat
 * the URI as a literal (nonexistent) path.
 */
export function toolOutputUriPlugin(): ToolPlugin {
  return {
    middleware: (next) => async (call, signal) => {
      const path = call.arguments.path;
      if (typeof path !== "string" || !isToolOutputLike(path)) {
        return next(call, signal);
      }
      if (call.name !== "read_file") {
        return {
          callId: call.id,
          content: `cannot ${call.name} a tool-output:// URI: ${path}. Use read_file with that URI to read the spilled output instead.`,
          isError: true,
        };
      }
      const normalized = normalizeToolOutputUri(path);
      if (normalized === path) {
        return next(call, signal);
      }
      return next({ ...call, arguments: { ...call.arguments, path: normalized } }, signal);
    },
  };
}