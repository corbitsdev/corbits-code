// MCP tools are registered as `mcp__<server>__<tool>`. That identifier is fine
// for dispatch but must never be shown to a person; these helpers turn it into a
// human label like "Linear: list projects". Shared by the TUI renderer and the
// permission layer so both present MCP tools the same way.

const MCP_PREFIX = "mcp__";

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_PREFIX);
}

export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  if (!isMcpToolName(name)) return null;
  const rest = name.slice(MCP_PREFIX.length);
  const sep = rest.indexOf("__");
  if (sep <= 0) return null;
  const server = rest.slice(0, sep);
  const tool = rest.slice(sep + 2);
  if (server.length === 0 || tool.length === 0) return null;
  return { server, tool };
}

function titleCase(word: string): string {
  return word.length === 0 ? word : word[0]!.toUpperCase() + word.slice(1);
}

// "mcp__linear__list_projects" -> "Linear: list projects". Falls back to the raw
// name only if it does not match the MCP shape (callers guard with isMcpToolName).
export function humanizeMcpTool(name: string): string {
  const parsed = parseMcpToolName(name);
  if (parsed === null) return name;
  const server = titleCase(parsed.server);
  const tool = parsed.tool.replace(/_/g, " ");
  return `${server}: ${tool}`;
}
