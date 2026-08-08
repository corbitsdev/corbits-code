import type { ToolPlugin } from "@intx/tools-posix";

const TRUNCATABLE_TOOLS = new Set(["read_file", "grep", "run_shell", "search_files", "web_fetch"]);

// Characters, not tokens — conversion ratio is roughly 4 chars/token.
// 80 000 chars ≈ 20 000 tokens. Keeps a single result from dominating context.
export const MAX_RESULT_CHARS = 80_000;

// The single primitive for size truncation: callers may pass their own
// threshold but never invent their own wording, so a result can never carry
// two differently-worded "truncated" notices. Called directly by runners this
// middleware does not wrap — the MCP tool runner (src/mcp/plugin.ts). The
// posix chain gets this middleware prepended unconditionally in
// posix-tool-plugins.ts, so plugins like ripgrepPlugin that answer without
// calling next() no longer need to apply the cap themselves.
export function truncateToolResultContent(
  content: string,
  maxChars: number = MAX_RESULT_CHARS,
): string {
  if (content.length <= maxChars) return content;

  const remaining = content.length - maxChars;
  return (
    content.slice(0, maxChars) +
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
