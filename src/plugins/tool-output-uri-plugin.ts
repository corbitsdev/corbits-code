import type { ToolPlugin } from "@intx/tools-posix";
import { normalizeToolOutputUri } from "../util/tool-output-uri.js";

/** Normalize read_file tool-output URIs before the posix handler resolves blobs. */
export function toolOutputUriPlugin(): ToolPlugin {
  return {
    middleware: (next) => async (call, signal) => {
      if (call.name !== "read_file") {
        return next(call, signal);
      }
      const path = call.arguments.path;
      if (typeof path !== "string") {
        return next(call, signal);
      }
      const normalized = normalizeToolOutputUri(path);
      if (normalized === path) {
        return next(call, signal);
      }
      return next({ ...call, arguments: { ...call.arguments, path: normalized } }, signal);
    },
  };
}