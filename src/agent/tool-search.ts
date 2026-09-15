import { stringTool } from "@intx/agent";
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { type } from "arktype";

import {
  lexicalFields,
  rankAndCut,
  scoreLexical,
  tokenizeLexical,
} from "./lexical-rank.js";
import type { SessionMode } from "../config/session-mode.js";
import { sessionModeEnablesSubAgents } from "../config/session-mode.js";

// Tools whose full schema is always advertised to the model. Everything else is
// registered but discovered on demand via tool_search, which promotes matches
// onto the call gate at once; the full schema joins the wire set at the next
// cache-safe boundary. Shared by the system prompt and
// the advertised-set gate so the two never drift.
//
// `present` is deliberately absent: most sessions never render a view, and at
// 2,793 chars it is the second-largest schema on the wire. It stays off the
// advertised prefix — the model finds it via tool_search when a session
// actually needs it.
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
  "shell_collect",
  "ask_operator",
  "manage_tasks",
  "tool_search",
  "use_skill",
  "search_agents",
  // Multi-agent dispatch is a first-class loop capability — always advertised so
  // the model can call spawn_agent immediately after search_agents without a
  // tool_search round-trip.
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
  "send_input",
];

const ORCHESTRATOR_ONLY_TOOL_NAMES: readonly string[] = [
  "search_agents",
  "spawn_agent",
  "wait_agents",
  "list_agents",
  "close_agent",
  "resume_agent",
  "interrupt_agent",
  "send_input",
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
  // Headless/non-TTY exec has no operator to answer. Omit to keep the TUI
  // default (mounted). False drops ask_operator from the advertised prefix
  // instead of leaving a cancel stub on the wire.
  operatorAvailable?: boolean;
  // Whether createAgentToolset mounted the wait_agents collection verb. True
  // only on exec primary; TUI primary and nested orchestrators omit it and
  // collect via mailbox mail instead. Omit to keep the unmounted default —
  // false/omitted filters wait_agents out of the core/advertised name sets.
  waitAgentsMounted?: boolean;
}

export function coreToolNamesForSessionMode(
  mode: SessionMode,
  availability: ToolAvailability,
): readonly string[] {
  const orchestratorEnabled = sessionModeEnablesSubAgents(mode);
  return CORE_TOOL_NAMES.filter((name) => {
    if (!orchestratorEnabled && ORCHESTRATOR_ONLY_TOOL_NAMES.includes(name))
      return false;
    if (name === "lsp") return availability.languageServerAvailable;
    if (name === "ask_operator")
      return availability.operatorAvailable !== false;
    if (name === "wait_agents") return availability.waitAgentsMounted === true;
    return true;
  });
}

export function advertisedToolNamesForSessionMode(
  mode: SessionMode,
  availability: ToolAvailability,
): readonly string[] {
  return [
    ...coreToolNamesForSessionMode(mode, availability),
    ...CATALOG_TOOL_NAMES,
  ];
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
  "skill_search",
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

// Project the live tool registry onto the advertised set: the fixed built-in
// prefix (its order never changes — this is what keeps the provider cache
// prefix stable) followed by wire-committed tools (MCP or otherwise) in
// first-commit order. The wire array is byte-stable turn to turn: callers pass
// only names committed via flushPromotions at a cache-safe boundary, never the
// live activation list, so a mid-session discovery cannot append here.
// `activated` is expected to already be deduped/ordered (see
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
  has(name: string): boolean;
  list(): string[];
  // Session rotation (/clear, /new) mints a new transcript whose model never
  // saw the activations — the advertised set starts clean with it.
  clear(): void;
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
    has(name: string): boolean {
      return activeNames.has(name);
    },
    list(): string[] {
      return [...activeNames];
    },
    clear(): void {
      activeNames.clear();
    },
  };
}

export const toolSearchDefinition: ToolDefinition = {
  name: "tool_search",
  description:
    "Discover callable tools by capability. Most tools — MCP servers, present, and other integrations — are not callable until this search promotes them. Core tools (read_file, run_shell, web_fetch, web_search, spawn_agent, …) are already on the wire — do not tool_search for them. wait_agents is mounted on exec-primary runs only, so it is not on the wire elsewhere and this search cannot promote it there. Call this with a short description of what you need (e.g. 'issue tracker', 'render layout', 'granola notes') to get matching tools' names, descriptions, and input schemas. Matched tools are promoted and callable on return — invoke them directly, no separate load step.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "A short description of the capability you need.",
      },
    },
    required: ["query"],
  },
};

export interface ToolIndex {
  // Rank registered tools against a query, returning the best-matching tool names.
  search(query: string, limit?: number): string[];
}

// Rank registered tools against name + description via the shared lexical
// scorer. Already-advertised tools are always callable so they never rank;
// the allow list (when set) keeps search from promoting outside it.
export function createToolIndex(
  getDefs: () => readonly ToolDefinition[],
  advertisedNames: readonly string[] = ADVERTISED_TOOL_NAMES,
  // Closed allow list (exec director overlays): when set, the index only
  // surfaces allowed tools so search cannot promote outside the allow.
  allow?: readonly string[] | undefined,
): ToolIndex {
  const score = (
    def: ToolDefinition,
    queryTokens: string[],
    rawQuery: string,
  ): number =>
    scoreLexical(
      lexicalFields(def.name, def.description ?? ""),
      queryTokens,
      rawQuery,
    );

  return {
    search(query: string, limit = 8): string[] {
      const rawQuery = query.toLowerCase().trim();
      const queryTokens = tokenizeLexical(query);
      if (queryTokens.length === 0) return [];
      const candidates = getDefs()
        .filter((def) => !advertisedNames.includes(def.name))
        .filter((def) => allow === undefined || allow.includes(def.name));
      return rankAndCut(
        candidates,
        (def) => score(def, queryTokens, rawQuery),
        limit,
      ).map((def) => def.name);
    },
  };
}

export interface ToolSearchDeps {
  search: (query: string) => string[];
  lookup: (name: string) => ToolDefinition | undefined;
  // Promote matches onto the call gate so the model can invoke them this turn
  // from the result card's schema. Wire declaration follows at the next
  // cache-safe boundary (compaction fold), never mid-thread.
  promote: (names: string[]) => void;
  // Resolves to the remaining in-flight MCP handshake count after waiting up
  // to `timeoutMs`. The toolset bounds its own wait; the handler re-races
  // below so even a stuck dependency can never hang the call. Omitted callers
  // (tests, ad-hoc indexes) have no pending handshakes to wait for.
  awaitPendingConnections?: (timeoutMs?: number) => Promise<number>;
  // True when a reconnecting MCP server holds retained tools that could match
  // `query`, justifying one short extra wait for the redial to remount them.
  // Only transport-death reconnects qualify — a needs-auth server settles
  // solely via out-of-band authorization, so extending the wait for one can
  // never help and this must stay false for them.
  hasReconnectingMatch?: (query: string) => boolean;
}

// Brief bound a tool_search miss waits for in-flight MCP handshakes before
// answering. A hung authorization must never hang the call, so both the
// toolset wait and the handler race below are capped by this.
export const TOOL_SEARCH_PENDING_WAIT_MS = 1_000;

// Short extension past the tier-1 wait, taken at most once and only when a
// reconnecting server holds tools that could match the query. Covers the
// redial window where the stubs are dropped and the live set is not yet
// remounted. Never taken for needs-auth: those servers settle solely via
// out-of-band authorization.
export const TOOL_SEARCH_RECONNECT_WAIT_MS = 500;

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

// Race the dependency's pending-count wait against a bound, so a
// stuck dependency (hung OAuth that never settles) cannot hang the call.
// Resolves undefined when this race itself times out.
async function racePendingCount(
  awaitPending: (timeoutMs?: number) => Promise<number>,
  timeoutMs: number,
): Promise<number | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      awaitPending(timeoutMs),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
      if (query.length === 0)
        return "Error: tool_search requires a non-empty query.";
      let names = deps.search(query);
      if (names.length === 0 && deps.awaitPendingConnections !== undefined) {
        // Tier 1 — miss while connectors start up: wait briefly, then
        // re-search so late-mounting tools land. The race bounds even a stuck
        // dependency (hung OAuth) — undefined means the wait itself timed out.
        let stillPending = await racePendingCount(
          deps.awaitPendingConnections,
          TOOL_SEARCH_PENDING_WAIT_MS,
        );
        names = deps.search(query);
        if (
          names.length === 0 &&
          (stillPending ?? 1) > 0 &&
          deps.hasReconnectingMatch?.(query) === true
        ) {
          // Tier 2 — a reconnecting server holds tools that could match: one
          // short extension for the redial to remount them, then a final
          // re-search. Needs-auth never qualifies (see the dep contract), so
          // a hung authorization still answers within the tier-1 bound.
          stillPending = await racePendingCount(
            deps.awaitPendingConnections,
            TOOL_SEARCH_RECONNECT_WAIT_MS,
          );
          names = deps.search(query);
        }
        if (names.length === 0 && (stillPending ?? 1) > 0) {
          const detail =
            stillPending === undefined
              ? "a connector may still be starting up"
              : stillPending === 1
                ? "1 connector is still connecting"
                : `${stillPending} connectors are still connecting`;
          return `No tools matched "${query}" yet — ${detail}. Retry this search shortly.`;
        }
      }
      if (names.length === 0) {
        return `No tools matched "${query}". Try different keywords describing the capability.`;
      }
      // Matches open on the call gate at once; the full schema joins the wire
      // declarations at the next cache-safe boundary (compaction fold), never
      // mid-thread, so the provider's cached prefix stays byte-stable. The
      // tool result below still carries name, description, AND input schema
      // so the model can shape arguments and call this same turn, before the
      // promoted definition is declared on the wire.
      deps.promote(names);
      const blocks = names.map((name) =>
        renderToolCard(deps.lookup(name), name),
      );
      return `These tools are available — you can call them now:\n\n${blocks.join("\n\n")}`;
    },
  });
}
