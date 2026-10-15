import type { ToolPlugin } from "@intx/tools-posix";
import {
  isToolOutputLike,
  normalizeToolOutputUri,
} from "../util/tool-output-uri.js";
import { virtualRefVerdict } from "./path-escape-plugin.js";
import { denyResult } from "./tool-args.js";

/**
 * Normalize read_file tool-output URIs before the posix handler or read-file
 * guard resolves blobs. Other `path` tools (grep, search_files, ...) reject
 * the scheme here — they have no blob reader and would treat the URI as a
 * literal (nonexistent) path.
 */
export function toolOutputUriPlugin(): ToolPlugin {
  return {
    middleware: (next) => async (call, signal) => {
      const path = call.arguments.path;
      if (typeof path !== "string" || !isToolOutputLike(path)) {
        return next(call, signal);
      }
      // path-escape's verdict is the single wording home for the
      // tool-output:// deny; this plugin just applies it earlier in the stack.
      const verdict = virtualRefVerdict(path, call.name);
      if (verdict !== "skip") {
        if (typeof verdict === "string") {
          return denyResult(call.id, verdict);
        }
        return next(call, signal);
      }
      const normalized = normalizeToolOutputUri(path);
      if (normalized === path) {
        return next(call, signal);
      }
      return next(
        { ...call, arguments: { ...call.arguments, path: normalized } },
        signal,
      );
    },
  };
}
