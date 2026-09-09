import type { ToolPlugin } from "@intx/tools-posix";
import type { ToolResult } from "@intx/types/runtime";
import { scrubSecretShapedContent, scrubSecretShapedValue } from "./tool-result-secret-scrub.js";

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
      // Include error results: authorized failure evidence must still be scrubbed.
      if (!SCRUBBABLE_TOOLS.has(call.name)) return result;

      if (typeof result.content === "string") {
        const scrubbed = scrubSecretShapedContent(result.content);
        if (scrubbed === result.content) return result;
        return { ...result, content: scrubbed };
      }

      if (result.content !== null && typeof result.content === "object") {
        const scrubbed = scrubSecretShapedValue(result.content);
        if (scrubbed === result.content) return result;
        // Keep a validated object shape — never coerce scrubbed Records to a
        // JSON string (that broke downstream structure-aware consumers).
        if (isRecord(scrubbed)) {
          const nextResult: ToolResult = { ...result, content: scrubbed };
          return nextResult;
        }
        return result;
      }

      return result;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
