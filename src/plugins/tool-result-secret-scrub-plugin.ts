import type { ToolPlugin } from "@intx/tools-posix";
import { scrubSecretShapedToolResultContent } from "./tool-result-secret-scrub.js";

const SCRUBBABLE_TOOLS = new Set(["grep", "run_shell", "read_file", "search_files"]);

export function toolResultSecretScrubPlugin(): ToolPlugin {
  return {
    middleware: (next) => async (call, signal) => {
      const result = await next(call, signal);
      if (!SCRUBBABLE_TOOLS.has(call.name) || result.isError) return result;

      if (typeof result.content === "string") {
        const scrubbed = scrubSecretShapedToolResultContent(result.content);
        if (scrubbed === result.content) return result;
        return { ...result, content: scrubbed };
      }

      if (result.content !== null && typeof result.content === "object") {
        const serialized = JSON.stringify(result.content);
        const scrubbed = scrubSecretShapedToolResultContent(serialized);
        if (scrubbed === serialized) return result;
        return { ...result, content: scrubbed };
      }

      return result;
    },
  };
}