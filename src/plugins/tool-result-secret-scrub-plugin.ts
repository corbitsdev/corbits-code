import type { ToolPlugin } from "@intx/tools-posix";
import { scrubSecretShapedContent } from "./tool-result-secret-scrub.js";

// Posix-middleware scrub path only. search_agents is listed for future unified
// scrubbing if it ever rides this middleware; live scrub for profile bodies is in
// formatAgentSearchResults (agent-search.ts) because search_agents is a core agent
// tool and never hits the posix ToolPlugin chain.
const SCRUBBABLE_TOOLS = new Set([
  "grep",
  "run_shell",
  "read_file",
  "search_files",
  "search_agents",
]);

export function toolResultSecretScrubPlugin(): ToolPlugin {
  return {
    middleware: (next) => async (call, signal) => {
      const result = await next(call, signal);
      if (!SCRUBBABLE_TOOLS.has(call.name) || result.isError) return result;

      if (typeof result.content === "string") {
        const scrubbed = scrubSecretShapedContent(result.content);
        if (scrubbed === result.content) return result;
        return { ...result, content: scrubbed };
      }

      if (result.content !== null && typeof result.content === "object") {
        const serialized = JSON.stringify(result.content);
        const scrubbed = scrubSecretShapedContent(serialized);
        if (scrubbed === serialized) return result;
        return { ...result, content: scrubbed };
      }

      return result;
    },
  };
}
