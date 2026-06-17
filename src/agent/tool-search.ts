import { stringTool } from "@intx/agent";
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { type } from "arktype";

// Tools whose full schema is always advertised to the model. Everything else is
// registered and dispatchable but discovered on demand via tool_search, keeping
// the per-turn context small. Shared by the system prompt and the advertised-set
// gate so the two never drift.
export const CORE_TOOL_NAMES: readonly string[] = [
  "read_file",
  "edit_file",
  "lsp",
  "run_shell",
  "ask_operator",
  "manage_tasks",
  "suggest_workflow",
  "present",
  "tool_search",
];

// Built-in tools surfaced in the prompt as one-line summaries (no schema) so the
// model knows they exist and can load them with tool_search. MCP tools are not
// listed at all — they are discovered blind.
export const CATALOG_TOOL_NAMES: readonly string[] = [
  "write_file",
  "search_files",
  "grep",
  "list_dir",
  "web_search",
  "web_fetch",
  "task",
];

export const toolSearchDefinition: ToolDefinition = {
  name: "tool_search",
  description:
    "Discover and load additional tools by capability. Most tools — file search, web access, sub-agents, and any connected integrations — are not loaded by default. Call this with a short description of what you need (e.g. 'create a file', 'search the web', 'find files', 'issue tracker') to load the matching tools, then call them on the next turn.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "A short description of the capability you need." },
    },
    required: ["query"],
  },
};

export type ToolIndex = {
  // Rank registered tools against a query, returning the best-matching tool names.
  search(query: string, limit?: number): string[];
};

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

// A dependency-free lexical ranker over each tool's name + description. Exact name
// token hits weigh most, then description token hits, then raw-substring matches
// (so "linear" finds mcp__linear__* even though it is not a whole token there).
export function createToolIndex(getDefs: () => readonly ToolDefinition[]): ToolIndex {
  const score = (def: ToolDefinition, queryTokens: string[], rawQuery: string): number => {
    const nameTokens = tokenize(def.name);
    const descTokens = new Set(tokenize(def.description ?? ""));
    let total = 0;
    for (const token of queryTokens) {
      if (nameTokens.includes(token)) total += 3;
      else if (descTokens.has(token)) total += 1;
      else if (def.name.toLowerCase().includes(token)) total += 0.75;
      else if ((def.description ?? "").toLowerCase().includes(token)) total += 0.25;
    }
    if (def.name.toLowerCase().includes(rawQuery)) total += 1;
    return total;
  };

  return {
    search(query: string, limit = 8): string[] {
      const rawQuery = query.toLowerCase().trim();
      const queryTokens = tokenize(query);
      if (queryTokens.length === 0) return [];
      return getDefs()
        .filter((def) => !CORE_TOOL_NAMES.includes(def.name))
        .map((def) => ({ name: def.name, score: score(def, queryTokens, rawQuery) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((entry) => entry.name);
    },
  };
}

export type ToolSearchDeps = {
  search: (query: string) => string[];
  lookup: (name: string) => ToolDefinition | undefined;
  // Make the matched tools available (advertise their schemas) for subsequent turns.
  promote: (names: string[]) => void;
};

const ToolSearchArgs = type({ query: "string" });

export function createToolSearchTool(deps: ToolSearchDeps): AgentTool {
  return stringTool({
    definition: toolSearchDefinition,
    handler: async (rawArgs: Record<string, unknown>): Promise<string> => {
      const parsed = ToolSearchArgs(rawArgs);
      if (parsed instanceof type.errors) {
        return "Error: tool_search requires query (string).";
      }
      const query = parsed.query.trim();
      if (query.length === 0) return "Error: tool_search requires a non-empty query.";
      const names = deps.search(query);
      if (names.length === 0) {
        return `No tools matched "${query}". Try different keywords describing the capability.`;
      }
      deps.promote(names);
      const lines = names.map((name) => `- ${name}: ${deps.lookup(name)?.description ?? ""}`);
      return `Loaded these tools — you can call them now:\n${lines.join("\n")}`;
    },
  });
}
