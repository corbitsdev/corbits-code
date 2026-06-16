import type { ToolPlugin } from "@intx/tools-posix";

const TRUNCATABLE_TOOLS = new Set(["read_file", "grep", "run_shell", "search_files", "web_fetch"]);

// Characters, not tokens — conversion ratio is roughly 4 chars/token.
// 80 000 chars ≈ 20 000 tokens. Keeps a single result from dominating context.
const MAX_RESULT_CHARS = 80_000;

export function resultTruncationPlugin(): ToolPlugin {
  return {
    middleware: (next) => async (call, signal) => {
      const result = await next(call, signal);
      if (!TRUNCATABLE_TOOLS.has(call.name) || result.isError) return result;

      const { content } = result;
      if (typeof content !== "string" || content.length <= MAX_RESULT_CHARS) return result;

      const remaining = content.length - MAX_RESULT_CHARS;
      return {
        ...result,
        content:
          content.slice(0, MAX_RESULT_CHARS) +
          `\n[output truncated — ${remaining.toLocaleString()} characters omitted. ` +
          `Use offset/limit params or a more targeted query to see the rest.]`,
      };
    },
  };
}
