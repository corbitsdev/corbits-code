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

const MCP_MUTATING_TOOL_PREFIXES = [
  "save_",
  "create_",
  "update_",
  "delete_",
  "remove_",
  "add_",
  "set_",
  "patch_",
  "post_",
  "put_",
  "merge_",
  "move_",
  "archive_",
  "unarchive_",
  "upload_",
  "import_",
  "assign_",
  "delegate_",
  "prepare_",
  "write_",
  "send_",
  "submit_",
  "apply_",
  "execute_",
  "publish_",
] as const;

const MCP_READ_ONLY_TOOL_PREFIXES = [
  "list_",
  "get_",
  "search_",
  "find_",
  "read_",
  "describe_",
  "show_",
  "view_",
  "query_",
  "lookup_",
  "fetch_",
] as const;

function mcpToolSegmentMatchesPrefix(segment: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => segment.startsWith(prefix));
}

// Name-prefix fallback when a server omits ToolAnnotations on tools/list.
export function isReadOnlyMcpTool(name: string): boolean {
  const parsed = parseMcpToolName(name);
  if (parsed === null) return false;
  const segment = parsed.tool;
  if (mcpToolSegmentMatchesPrefix(segment, MCP_MUTATING_TOOL_PREFIXES)) return false;
  return mcpToolSegmentMatchesPrefix(segment, MCP_READ_ONLY_TOOL_PREFIXES);
}
