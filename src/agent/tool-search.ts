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
//
// `present` is deliberately absent: most sessions never render a view, and at
// 2,793 chars it is the second-largest schema on the wire. It stays fully
// dispatchable — the model finds it via tool_search when a session actually
// needs it.
//
// Product mutation tools (write_file / edit_file / delete_file) sit in CORE so
// the primary Skywalker session can DIY tiny/bounded edits without a
// tool_search round-trip. Substantial work still spawns build / docs
// directors — that is a prompt judgment call, not a toolset strip.
// Codex `apply_patch` is mounted only when isCodex and kept on build/docs
// leaves — it is intentionally absent from CORE/CATALOG.
export const CORE_TOOL_NAMES: readonly string[] = [
  "read_file",
  "write_file",
  "edit_file",
  "delete_file",
  "lsp",
  "run_shell",
  "ask_operator",
  "manage_tasks",
  "tool_search",
  "use_skill",
  "search_agents",
  // Multi-agent dispatch is a first-class loop capability — always advertised so
  // the model can call task immediately after search_agents without a tool_search
  // round-trip. Catalog-only placement left the model discovering profiles then
  // failing on an unloaded task tool.
  "task",
  // Fleet verbs (non-blocking spawn + lifecycle). Mounted on primary when
  // subAgent is wired; advertised here so the model does not tool_search for
  // them. Package allowlists (ORCHESTRATOR_TOOLS / SKYWALKER_TOOLS) are a
  // separate, deferred change.
  "spawn_agent",
  "wait_agents",
  "list_agents",
  "close_agent",
  "resume_agent",
  "interrupt_agent",
  "followup_task",
];

const ORCHESTRATOR_ONLY_TOOL_NAMES: readonly string[] = [
  "search_agents",
  "task",
  "spawn_agent",
  "wait_agents",
  "list_agents",
  "close_agent",
  "resume_agent",
  "interrupt_agent",
  "followup_task",
];

// Session-start facts that gate a core tool's advertisement. Each must be
// knowable once, before the first inference call, and must never change for
// the life of the session — the tools array is a provider cache prefix (see
// ADVERTISED_TOOL_NAMES below), so a value that could flip mid-session would
// force a re-prefill worse than the schema bytes it saves.
export interface ToolAvailability {
  // Whether a language server was resolvable for this project at startup —
  // not whether one currently responds.
  languageServerAvailable: boolean;
}

export function coreToolNamesForSessionMode(
  mode: SessionMode,
  availability: ToolAvailability,
): readonly string[] {
  const orchestratorEnabled = sessionModeEnablesSubAgents(mode);
  return CORE_TOOL_NAMES.filter((name) => {
    if (!orchestratorEnabled && ORCHESTRATOR_ONLY_TOOL_NAMES.includes(name)) return false;
    if (name === "lsp") return availability.languageServerAvailable;
    return true;
  });
}

export function advertisedToolNamesForSessionMode(
  mode: SessionMode,
  availability: ToolAvailability,
): readonly string[] {
  return [...coreToolNamesForSessionMode(mode, availability), ...CATALOG_TOOL_NAMES];
}

// Built-in file/search/web tools advertised alongside the core set. They carry full
// schemas on the wire so the model can call them directly; MCP tools are not
// listed at all — they are discovered blind via tool_search.
// write_file / edit_file / delete_file live in CORE (not here) so they are
// advertised without a tool_search round-trip.
// web_fetch / web_search are catalog (not deferred): URL reads and search are
// first-class primary work; requiring tool_search before web_fetch caused
// thrash on web-bait and contradicted the skywalker "already mounted" rule.
export const CATALOG_TOOL_NAMES: readonly string[] = [
  "search_files",
  "grep",
  "list_dir",
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
export const ADVERTISED_TOOL_NAMES: readonly string[] = [...CORE_TOOL_NAMES, ...CATALOG_TOOL_NAMES];

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
export interface ActivatedToolTracker {
  // Adds any new names and returns whether the set actually changed.
  activate(names: readonly string[]): boolean;
  list(): string[];
}

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
    "Discover callable tools by capability. Most tools — MCP servers, present, and other integrations — are dispatchable but not advertised in the tools list. Core tools (read_file, run_shell, web_fetch, web_search, task, …) are already on the wire — do not tool_search for them. Call this with a short description of what you need (e.g. 'issue tracker', 'render layout', 'granola notes') to get matching tools' names, descriptions, and input schemas. The returned tools are already callable — invoke them directly, no separate load step.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "A short description of the capability you need." },
    },
    required: ["query"],
  },
};

export interface ToolIndex {
  // Rank registered tools against a query, returning the best-matching tool names.
  search(query: string, limit?: number): string[];
}

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

export interface ToolSearchDeps {
  search: (query: string) => string[];
  lookup: (name: string) => ToolDefinition | undefined;
  // Make the matched tools' names part of the advertised wire set on the next
  // inference. Every registered tool is already dispatchable via `run`, so this
  // only affects what the model can see without an intervening tool_search.
  promote: (names: string[]) => void;
}

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
