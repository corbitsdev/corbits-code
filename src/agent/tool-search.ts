import { stringTool } from "@intx/agent";
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { type } from "arktype";

import type { SessionMode } from "../config/session-mode.js";
import { sessionModeEnablesSubAgents } from "../config/session-mode.js";

// Fixed wire tools (full schemas every turn). Everything else is registered for
// free-name dispatch and discovered via tool_search — the wire never grows mid-
// session (Search & Execute / provider tools-array cache).
//
// Design (minimal fixed wire + no thrash):
//   CORE    — file/shell loop (read/write/edit/shell) + product loop (ask/tasks/search/skills)
//             + orchestrator spawn tools. Never put "nice to have" here.
//   CATALOG — only capabilities whose shell substitutes are *hard-blocked* by the
//             harness (bounded code search, SSRF-safe web). If the prompt or authz
//             requires a tool, it must sit on the wire — deferred + "use X" is what
//             made Grok 4.6 thrash on tool_search.
//
// Behind search (dispatchable by exact name): list_dir, lsp, present, MCP/plugins.
export const CORE_TOOL_NAMES: readonly string[] = [
  // File + shell loop
  "read_file",
  "edit_file",
  "write_file",
  "run_shell",
  // Product loop
  "ask_operator",
  "manage_tasks",
  "tool_search",
  "use_skill",
  // Multi-agent (orchestrator-only filter below)
  "search_agents",
  "task",
];

const ORCHESTRATOR_ONLY_TOOL_NAMES: readonly string[] = ["search_agents", "task"];

// Session-start facts that gate advertisement. Each must be knowable once before
// the first inference and stable for the session — the tools array is a provider
// cache prefix, so a flip mid-session re-prefills the whole request.
//
// `languageServerAvailable` is retained for callers that still detect LSP at
// boot; it no longer gates the wire (lsp is free-name / tool_search only).
export type ToolAvailability = {
  languageServerAvailable: boolean;
};

export function coreToolNamesForSessionMode(
  mode: SessionMode,
  _availability: ToolAvailability,
): readonly string[] {
  const orchestratorEnabled = sessionModeEnablesSubAgents(mode);
  return CORE_TOOL_NAMES.filter((name) => {
    if (!orchestratorEnabled && ORCHESTRATOR_ONLY_TOOL_NAMES.includes(name)) return false;
    return true;
  });
}

export function advertisedToolNamesForSessionMode(
  mode: SessionMode,
  availability: ToolAvailability,
): readonly string[] {
  return [...coreToolNamesForSessionMode(mode, availability), ...CATALOG_TOOL_NAMES];
}

// Only tools that replace a *blocked* shell path. Do not grow this with
// convenience tools (list_dir, lsp, present) — those thrash when models
// tool_search for them after the prompt names them, and stay fine as free-name
// when the model actually needs them.
export const CATALOG_TOOL_NAMES: readonly string[] = [
  "grep",
  "search_files",
  "web_fetch",
  "web_search",
];

// The maximal set of built-in tools — every gate open — in a deterministic
// order, used as the tool_search exclusion list and as a fallback prefix for
// callers with no session-start availability facts. Provider prompt caches
// are prefix caches keyed on the tools array (it sits before system +
// messages), so this order must never shift between turns — a reordered or
// grown array re-prefills the whole request.
//
// Primary TUI/exec sessions should pass
// `advertisedToolNamesForSessionMode(sessionMode, toolAvailability)` as the
// `builtInPrefix` to `advertisedTools` — not this constant alone.
export const ADVERTISED_TOOL_NAMES: readonly string[] = [
  ...CORE_TOOL_NAMES,
  ...CATALOG_TOOL_NAMES,
];

// Project the live tool registry onto the fixed advertised wire set. Membership
// and order come only from `builtInPrefix` — never from mid-session discovery.
// That keeps the provider tools-array prefix cache stable for the whole session
// (Search & Execute / free-name dispatch: catalog tools are callable by exact
// name through the registry without appearing here).
export function advertisedTools(
  all: readonly ToolDefinition[],
  builtInPrefix: readonly string[] = ADVERTISED_TOOL_NAMES,
): ToolDefinition[] {
  const byName = new Map(all.map((def) => [def.name, def]));
  const seen = new Set<string>();
  return builtInPrefix.flatMap((name) => {
    if (seen.has(name)) return [];
    seen.add(name);
    const def = byName.get(name);
    return def !== undefined ? [def] : [];
  });
}

export const toolSearchDefinition: ToolDefinition = {
  name: "tool_search",
  description:
    "Discover plugin/MCP tools that are not listed under Tools (issue trackers, etc.). " +
    "Returns exact names and compact input schemas. Call matches by exact name — they are " +
    "already dispatchable; search does not load or promote them onto the wire. Do not use " +
    "tool_search for file/shell/web/search work already listed under Tools, do not re-run " +
    "for the same need, and do not narrate a call in prose instead of invoking the tool.",
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

// Prefer Exa over first-party web tools when scores are close, then first-party
// over other MCP integrations, so a web query surfaces the hosted Exa path
// ahead of web_fetch / web_search and a long tail of unrelated mcp__* hits.
function preferenceBoost(name: string): number {
  if (name.startsWith("mcp__exa__")) return 0.6;
  if (name.startsWith("mcp__")) return 0;
  return 0.3;
}

// A dependency-free lexical ranker over each tool's name + description. Exact name
// token hits weigh most, then description token hits, then raw-substring matches
// (so "linear" finds mcp__linear__* even though it is not a whole token there).
// Default limit is small on purpose: long result cards invite models to re-search
// and thrash instead of calling the top match.
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
    // Preference only breaks ties among real matches — never invents a hit.
    if (total <= 0) return 0;
    return total + preferenceBoost(def.name);
  };

  return {
    search(query: string, limit = 3): string[] {
      const rawQuery = query.toLowerCase().trim();
      const queryTokens = tokenize(query);
      if (queryTokens.length === 0) return [];
      const ranked = getDefs()
        .filter((def) => !advertisedNames.includes(def.name))
        .map((def) => ({ name: def.name, score: score(def, queryTokens, rawQuery) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score);
      if (ranked.length === 0) return [];
      // Drop weak tail entries more than 2 points below the top score so a strong
      // name hit does not drag along near-zero description matches.
      const floor = ranked[0]!.score - 2;
      return ranked
        .filter((entry) => entry.score >= floor)
        .slice(0, limit)
        .map((entry) => entry.name);
    },
  };
}

export type ToolSearchDeps = {
  search: (query: string) => string[];
  lookup: (name: string) => ToolDefinition | undefined;
};

const ToolSearchArgs = type({ query: "string" });

// Render one discovered tool as name, description, and pretty-printed input
// schema. Unadvertised tools never appear in the wire tools array, so this card
// (plus free-name dispatch) is how the model learns parameters and then executes.
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
      // Search only. Execute is a free-name tool call against the registry —
      // never grow the wire tools array (provider cache prefix must stay fixed).
      // Cards carry schema so the model can shape arguments from history alone.
      const blocks = names.map((name) => renderToolCard(deps.lookup(name), name));
      return (
        `Matched tools (already dispatchable — call by exact name now; do not re-search):\n\n` +
        `${blocks.join("\n\n")}`
      );
    },
  });
}
