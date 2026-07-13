import { stringTool } from "@intx/agent";
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { type } from "arktype";

import type { SessionMode } from "../config/session-mode.js";
import { sessionModeEnablesSubAgents } from "../config/session-mode.js";

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
  "present",
  "tool_search",
  "use_skill",
  "search_agents",
  // Multi-agent dispatch is a first-class loop capability — always advertised so
  // the model can call task immediately after search_agents without a tool_search
  // round-trip. Catalog-only placement left the model discovering profiles then
  // failing on an unloaded task tool.
  "task",
];

const MULTI_AGENT_CORE_TOOL_NAMES: readonly string[] = ["search_agents", "task"];

export function coreToolNamesForSessionMode(mode: SessionMode): readonly string[] {
  if (!sessionModeEnablesSubAgents(mode)) {
    return CORE_TOOL_NAMES.filter((name) => !MULTI_AGENT_CORE_TOOL_NAMES.includes(name));
  }
  return CORE_TOOL_NAMES;
}

export function advertisedToolNamesForSessionMode(mode: SessionMode): readonly string[] {
  return [...coreToolNamesForSessionMode(mode), ...CATALOG_TOOL_NAMES];
}

// Built-in file/search tools advertised alongside the core set. They carry full
// schemas on the wire so the model can call them directly; MCP tools are not
// listed at all — they are discovered blind via tool_search.
export const CATALOG_TOOL_NAMES: readonly string[] = [
  "write_file",
  "search_files",
  "grep",
  "list_dir",
];

// The complete set of built-in tools whose schemas are always on the wire, in a
// deterministic order. Provider prompt caches are prefix caches keyed on the
// tools array (it sits before system + messages), so this order must never shift
// between turns — a reordered or grown array re-prefills the whole request.
//
// Primary TUI sessions should pass `advertisedToolNamesForSessionMode(sessionMode)`
// as the `builtInPrefix` to `advertisedTools` — not this constant alone.
export const ADVERTISED_TOOL_NAMES: readonly string[] = [
  ...CORE_TOOL_NAMES,
  ...CATALOG_TOOL_NAMES,
];

// Project the live tool registry onto the advertised set: the fixed built-in
// prefix (its order never changes — this is what keeps the provider cache
// prefix stable) followed by session-activated tools (MCP or otherwise) in
// first-activation order. The wire array is byte-stable turn to turn until a
// discovery appends a new name, at which point it grows once and then holds
// steady again. `activated` is expected to already be deduped/ordered (see
// `createActivatedToolTracker`), but names are deduped again here defensively
// so a caller passing raw matches still can't reorder or duplicate an entry.
export function advertisedTools(
  all: readonly ToolDefinition[],
  activated: readonly string[] = [],
  builtInPrefix: readonly string[] = ADVERTISED_TOOL_NAMES,
): ToolDefinition[] {
  const byName = new Map(all.map((def) => [def.name, def]));
  const seen = new Set<string>();
  const orderedNames = [
    ...builtInPrefix,
    ...activated.filter((name) => !builtInPrefix.includes(name)),
  ];
  return orderedNames.flatMap((name) => {
    if (seen.has(name)) return [];
    seen.add(name);
    const def = byName.get(name);
    return def !== undefined ? [def] : [];
  });
}

// Tracks which non-built-in tool names the session has activated (via
// tool_search matches, or a director-side trigger like the lsp hint), in
// first-activation order. Backed by a Set, so re-activating an already-active
// name is a no-op — it neither reorders nor duplicates the entry.
export type ActivatedToolTracker = {
  // Adds any new names and returns whether the set actually changed.
  activate(names: readonly string[]): boolean;
  list(): string[];
};

export function createActivatedToolTracker(): ActivatedToolTracker {
  const activeNames = new Set<string>();
  return {
    activate(names: readonly string[]): boolean {
      let changed = false;
      for (const name of names) {
        if (!activeNames.has(name)) {
          activeNames.add(name);
          changed = true;
        }
      }
      return changed;
    },
    list(): string[] {
      return [...activeNames];
    },
  };
}

export const toolSearchDefinition: ToolDefinition = {
  name: "tool_search",
  description:
    "Discover callable tools by capability. Most tools — file search, web access, and any connected integrations — are dispatchable but not advertised in the tools list. Call this with a short description of what you need (e.g. 'create a file', 'search the web', 'find files', 'issue tracker') to get the matching tools' names, descriptions, and input schemas. The returned tools are already callable — invoke them directly, no separate load step.",
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
export function createToolIndex(
  getDefs: () => readonly ToolDefinition[],
  advertisedNames: readonly string[] = ADVERTISED_TOOL_NAMES,
): ToolIndex {
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
        .filter((def) => !advertisedNames.includes(def.name))
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
  // Make the matched tools' names part of the advertised wire set on the next
  // inference. Every registered tool is already dispatchable via `run`, so this
  // only affects what the model can see without an intervening tool_search.
  promote: (names: string[]) => void;
};

const ToolSearchArgs = type({ query: "string" });

// Render one discovered tool as name, description, and pretty-printed input
// schema. The schema is the load-bearing addition: MCP and other unadvertised
// tools never appear in the wire tools array, so this is the model's only view
// of their parameter names, types, and required fields.
function renderToolCard(def: ToolDefinition | undefined, name: string): string {
  if (def === undefined) return `- ${name}`;
  const header = `- ${def.name}: ${def.description ?? ""}`;
  const schema = JSON.stringify(def.inputSchema ?? {}, null, 2);
  return `${header}\n  input schema:\n${indent(schema, "    ")}`;
}

function indent(text: string, pad: string): string {
  return text
    .split("\n")
    .map((line) => `${pad}${line}`)
    .join("\n");
}

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
      // Matches are promoted into the advertised set so the next inference
      // declares them on the wire — required for strict providers (e.g. the grok
      // Responses API) where a model cannot call a tool that was never declared.
      // The tool result below still carries name, description, AND input schema
      // so the model can shape arguments this same turn, before the promoted
      // definition round-trips through the next infer call.
      deps.promote(names);
      const blocks = names.map((name) => renderToolCard(deps.lookup(name), name));
      return `These tools are available — you can call them now:\n\n${blocks.join("\n\n")}`;
    },
  });
}
