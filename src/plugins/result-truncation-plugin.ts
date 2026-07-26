import type { ToolPlugin } from "@intx/tools-posix";

const TRUNCATABLE_TOOLS = new Set(["read_file", "grep", "run_shell", "search_files", "web_fetch"]);

// Characters, not tokens — conversion ratio is roughly 4 chars/token.
// 80 000 chars ≈ 20 000 tokens. Keeps a single result from dominating context.
const MAX_RESULT_CHARS = 80_000;

// Shared with the MCP tool runner (src/mcp/plugin.ts), which is not part of the
// posix runner this middleware wraps and so applies the same truncation directly.
export function truncateToolResultContent(content: string): string {
  if (content.length <= MAX_RESULT_CHARS) return content;

  const remaining = content.length - MAX_RESULT_CHARS;
  return (
    content.slice(0, MAX_RESULT_CHARS) +
    `\n[output truncated — ${remaining.toLocaleString()} characters omitted. ` +
    `Use offset/limit params or a more targeted query to see the rest.]`
  );
}

export function resultTruncationPlugin(): ToolPlugin {
  return {
    middleware: (next) => async (call, signal) => {
      const result = await next(call, signal);
      if (!TRUNCATABLE_TOOLS.has(call.name) || result.isError) return result;

      const { content } = result;
      if (typeof content !== "string") return result;
      const truncated = truncateToolResultContent(content);
      if (truncated === content) return result;
      return { ...result, content: truncated };
    },
  };
}
