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
  // Truncation happens here, at the source — before the reactor's size-cap
  // transform spills to a tool-output:/// blob. The blob therefore holds only
  // this already-truncated text, so the marker must say the remainder is gone:
  // a "see the blob for the rest" promise would send the model chasing content
  // that does not exist and re-running the command in a loop.
  return (
    content.slice(0, maxChars) +
    `\n[output truncated at ${maxChars.toLocaleString()} chars — ` +
    `${remaining.toLocaleString()} chars discarded, NOT retrievable ` +
    `(no tool-output URI has them; re-running gives the same cut). ` +
    `Use offset/limit or a narrower query.]`
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
