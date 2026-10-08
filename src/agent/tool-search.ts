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
import {
  advertisedToolName,
  projectToolDefinition,
  type ToolProfile,
} from "./tool-aliases.js";
import { canonicalToolName } from "./canonical-tool-name.js";
import { ORCHESTRATOR_TOOLS, READ_TOOLS } from "./directors/tool-sets.js";

// Always advertised with full schema; everything else is discovered via
// tool_search (top cards join the next infer's advertised tail; the rest
// stay name + description until called — promote-on-execute). Shared by the
// system prompt and the advertised-set gate so the two never drift.
// `present` stays off: rarely rendered and the second-largest wire schema,
// so tool_search finds it on demand. Write/edit/delete stay in CORE so the
// primary dispatch can do tiny/bounded edits without a search round-trip;
// substantial work spawns build / docs directors. Codex natives
// (apply_patch / shell / update_plan) are not advertised.
export const CORE_TOOL_NAMES: readonly string[] = [
  "read",
  "write",
  "edit",
  "delete",
  "lsp",
  "bash",
  "ask_operator",
  "manage_tasks",
  "tool_search",
  "use_skill",
  "search_agents",
  // Fleet verbs: mounted on primary when subAgent is wired; advertised so
  // the model skips a tool_search round-trip.
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

// Session-start facts gating a core tool's advertisement, fixed for the
// session: the tools array is a provider cache prefix, so a value that
// could flip mid-session forces a re-prefill worse than the bytes it saves.
export interface ToolAvailability {
  // Whether a language server was resolvable for this project at startup.
  languageServerAvailable: boolean;
  // Headless/non-TTY exec has no operator to answer. False drops
  // ask_operator from the advertised prefix instead of leaving a cancel
  // stub on the wire; omit keeps the TUI default.
  operatorAvailable?: boolean;
  // Whether createAgentToolset mounted wait_agents: true only on exec
  // primary; TUI primary and nested orchestrators collect via mailbox mail.
  // False/omitted filters it out of the core and advertised name sets.
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

const WORKER_WIRE_ALWAYS: readonly string[] = [
  "tool_search",
  "ask_director",
  "submit_result",
];

/**
 * Advertised wire prefix for a spawned worker: the director's tool allowlist
 * plus `tool_search` and the leaf reporting channel. No shared preset across
 * roles; MCP stays off until tool_search / promote-on-execute.
 */
export function advertisedToolNamesForWorker(opts: {
  allow?: readonly string[];
  orchestrator?: boolean;
  languageServerAvailable?: boolean;
}): readonly string[] {
  const base =
    opts.allow !== undefined && opts.allow.length > 0
      ? opts.allow
      : opts.orchestrator === true
        ? ORCHESTRATOR_TOOLS
        : READ_TOOLS;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of [...base, ...WORKER_WIRE_ALWAYS]) {
    if (name === "ask_operator" || name === "search_agents") continue;
    if (name === "wait_agents") continue;
    if (name === "lsp" && opts.languageServerAvailable !== true) continue;
    if (name.startsWith("mcp__")) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

// Built-in file/search/web tools advertised with full schema alongside the
// core set; MCP tools are absent — discovered blind via tool_search. list_dir
// stays mounted but unadvertised and excluded from tool_search (use glob).
// web_fetch/web_search are catalog, not deferred: URL reads and search are
// first-class primary work; gating them behind tool_search thrashed on
// web-bait.
export const CATALOG_TOOL_NAMES: readonly string[] = [
  "glob",
  "grep",
  "web_fetch",
  "web_search",
];

// Maximal built-in tool set — every gate open — in a deterministic order:
// the tool_search exclusion list and the fallback prefix for callers with no
// session-start availability facts. Provider caches are prefix caches keyed
// on the tools array, so this order must never shift between turns — a
// reordered or grown array re-prefills the whole request.
//
// Primary sessions pass `advertisedToolNamesForSessionMode(...)` as the
// `builtInPrefix` to `advertisedTools`, not this constant alone.
export const ADVERTISED_TOOL_NAMES: readonly string[] = [
  ...CORE_TOOL_NAMES,
  ...CATALOG_TOOL_NAMES,
];

function isAlreadyAdvertised(
  defName: string,
  advertisedNames: readonly string[],
): boolean {
  const engine = canonicalToolName(defName);
  const wire = advertisedToolName(engine);
  return (
    advertisedNames.includes(defName) ||
    advertisedNames.includes(engine) ||
    advertisedNames.includes(wire)
  );
}

// Mounted built-ins kept off the advertised prefix, tool_search, and
// promote-on-execute flushes — dispatch without advertising. glob is the
// advertised replacement for list_dir.
export const UNADVERTISED_MOUNTED_BUILTINS = new Set([
  "list_dir",
  "apply_patch",
]);

// Project the live tool registry onto the advertised set: the fixed built-in
// prefix (order never changes, keeping the provider cache prefix stable)
// followed by wire-committed tools in first-commit order. Callers pass names
// committed via flushPromotions (on promote and at cache-safe boundaries),
// never the live activation list, so a mid-handler discovery cannot append
// until the promoter commits it. Names are deduped so raw matches cannot
// reorder or duplicate an entry.
export function advertisedTools(
  all: readonly ToolDefinition[],
  activated: readonly string[] = [],
  builtInPrefix: readonly string[] = ADVERTISED_TOOL_NAMES,
  profile: ToolProfile = "default",
): ToolDefinition[] {
  const byName = new Map<string, ToolDefinition>();
  for (const def of all) {
    byName.set(def.name, def);
    const engine = canonicalToolName(def.name);
    if (!byName.has(engine)) byName.set(engine, def);
    const wire = advertisedToolName(engine, profile);
    if (!byName.has(wire)) byName.set(wire, def);
  }
  const seen = new Set<string>();
  const orderedNames = [
    ...builtInPrefix,
    ...activated.filter((name) => !builtInPrefix.includes(name)),
  ];
  return orderedNames.flatMap((name) => {
    const def = byName.get(name) ?? byName.get(canonicalToolName(name));
    if (def === undefined) return [];
    const projected = projectToolDefinition(def, profile);
    if (seen.has(projected.name)) return [];
    seen.add(projected.name);
    return [projected];
  });
}

// Non-built-in tool names the session has activated (promote-on-execute of a
// called name, or a director-side trigger like the lsp hint), in
// first-activation order. Backed by a Set: re-activating a known name is a
// no-op.
export interface ActivatedToolTracker {
  // Adds any new names; returns whether the set changed.
  activate(names: readonly string[]): boolean;
  has(name: string): boolean;
  list(): string[];
  // Session rotation (/clear, /new) mints a fresh transcript whose model
  // never saw the activations — the advertised set starts clean with it.
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
    "Find tools (MCP servers, integrations) and skills by capability. Top matches include input schema and join the tool list on the next turn (default 5). Unused matches stay off the list. Load a skill body with use_skill.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Capability needed.",
      },
      limit: {
        type: "number",
        description:
          "Max matches to return (default 5, hard cap 20). Override when you need a wider set.",
      },
    },
    required: ["query"],
  },
};

export interface ToolIndex {
  // Rank registered tools against a query; return the best-matching names.
  search(query: string, limit?: number): string[];
}

// Lexical search knobs: already-advertised tools are always callable so they
// never rank; the allow list (when set) keeps search from listing outside it.
export const TOOL_SEARCH_MAX_RESULTS = 5;
export const TOOL_SEARCH_LIMIT_MAX = 20;
export const TOOL_SEARCH_SCORE_RATIO = 0.75;
export const TOOL_SEARCH_DESC_MAX = 160;
export const TOOL_SEARCH_SCHEMA_MAX = 600;
export const TOOL_SEARCH_SCHEMA_CARDS = 5;

export function createToolIndex(
  getDefs: () => readonly ToolDefinition[],
  advertisedNames: readonly string[] = ADVERTISED_TOOL_NAMES,
  // Closed allow list (exec director overlays): search only surfaces allowed
  // tools.
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
    search(query: string, limit = TOOL_SEARCH_MAX_RESULTS): string[] {
      const rawQuery = query.toLowerCase().trim();
      const queryTokens = tokenizeLexical(query);
      if (queryTokens.length === 0) return [];
      const candidates = getDefs()
        .filter((def) => !isAlreadyAdvertised(def.name, advertisedNames))
        .filter((def) => !UNADVERTISED_MOUNTED_BUILTINS.has(def.name))
        .filter(
          (def) =>
            allow === undefined ||
            allow.includes(def.name) ||
            allow.some(
              (allowed) =>
                canonicalToolName(allowed) === canonicalToolName(def.name),
            ),
        );
      return rankAndCut(
        candidates,
        (def) => score(def, queryTokens, rawQuery),
        limit,
        TOOL_SEARCH_SCORE_RATIO,
      ).map((def) => def.name);
    },
  };
}

export interface ToolSearchDeps {
  search: (query: string, limit?: number) => string[];
  // Skill matches as "- name: description" lines, rendered beside tool matches.
  searchSkills?: (query: string) => string[];
  lookup: (name: string) => ToolDefinition | undefined;
  // Load the top ranked names onto the next infer's advertised tail. Omitted
  // in unit tests that only assert card text.
  promote?: (names: string[]) => void;
  // Remaining in-flight MCP handshake count after a bounded wait. The
  // handler re-races this so a stuck dependency (hung OAuth) cannot hang the
  // call. Omitted callers have no pending handshakes.
  awaitPendingConnections?: (timeoutMs?: number) => Promise<number>;
  // True when a reconnecting MCP server holds tools that could match
  // `query`, justifying one short extra wait for the redial to remount them.
  // Only transport-death reconnects qualify; needs-auth settles
  // out-of-band, so waiting never helps.
  hasReconnectingMatch?: (query: string) => boolean;
  // Bounded wait before answering a miss with late-mounting tools, in ms.
  // Defaults to TOOL_SEARCH_PENDING_WAIT_MS; tests override it to exercise
  // the bounded-wait contract without paying the production 1s.
  pendingWaitMs?: number;
}

// Cap on a tool_search miss's wait for in-flight MCP handshakes: a hung
// authorization must never hang the call, so the toolset wait and the
// handler race below both use this bound.
export const TOOL_SEARCH_PENDING_WAIT_MS = 1_000;

// Short extension past the tier-1 wait, at most once, and only when a
// reconnecting server holds tools that could match the query — the redial
// window where stubs are dropped and the live set is not yet remounted.
// Never taken for needs-auth: those settle out-of-band.
export const TOOL_SEARCH_RECONNECT_WAIT_MS = 500;

const ToolSearchArgs = type({
  query: "string",
  "limit?": "number",
});

function resolveSearchLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return TOOL_SEARCH_MAX_RESULTS;
  }
  const n = Math.trunc(value);
  if (n < 1) return TOOL_SEARCH_MAX_RESULTS;
  return Math.min(n, TOOL_SEARCH_LIMIT_MAX);
}

function parseToolSearchArgs(
  rawArgs: Record<string, unknown>,
): { error: string } | { query: string; limit: number } {
  const parsed = ToolSearchArgs(rawArgs);
  const queryRaw = parsed instanceof type.errors ? rawArgs.query : parsed.query;
  if (typeof queryRaw !== "string") {
    return { error: "Error: tool_search requires query (string)." };
  }
  const query = queryRaw.trim();
  if (query.length === 0) {
    return { error: "Error: tool_search requires a non-empty query." };
  }
  const limit =
    parsed instanceof type.errors
      ? TOOL_SEARCH_MAX_RESULTS
      : resolveSearchLimit(parsed.limit);
  return { query, limit };
}

function capDescription(text: string, max = TOOL_SEARCH_DESC_MAX): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

function isEmptyInputSchema(schema: unknown): boolean {
  if (schema === undefined || schema === null) return true;
  if (typeof schema !== "object") return true;
  const json = JSON.stringify(schema);
  return (
    json === "{}" ||
    json === '{"type":"object"}' ||
    json === '{"type":"object","properties":{}}' ||
    json === '{"type":"object","properties":{},"required":[]}'
  );
}

function compactInputSchema(schema: unknown): string | undefined {
  if (isEmptyInputSchema(schema)) return undefined;
  const json = JSON.stringify(schema);
  if (json.length <= TOOL_SEARCH_SCHEMA_MAX) return json;
  const obj = schema as Record<string, unknown>;
  const properties = obj.properties;
  const keys =
    properties !== undefined &&
    typeof properties === "object" &&
    properties !== null
      ? Object.keys(properties)
      : [];
  const required = Array.isArray(obj.required) ? obj.required : [];
  const stub = JSON.stringify({ properties: keys, required });
  if (stub.length <= TOOL_SEARCH_SCHEMA_MAX) return stub;
  return `${stub.slice(0, TOOL_SEARCH_SCHEMA_MAX - 1)}…`;
}

function renderToolCard(
  def: ToolDefinition | undefined,
  name: string,
  includeSchema: boolean,
): string {
  if (def === undefined) return `- ${name}`;
  const desc = capDescription(def.description ?? "");
  const schema = includeSchema
    ? compactInputSchema(def.inputSchema)
    : undefined;
  if (schema === undefined) return `- ${def.name}: ${desc}`;
  return `- ${def.name}: ${desc}\n  ${schema}`;
}

// Race the dependency's pending-count wait against a bound so a stuck
// dependency (hung OAuth) cannot hang the call. Undefined when the race
// itself times out.
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
      const parsed = parseToolSearchArgs(rawArgs);
      if ("error" in parsed) return parsed.error;
      const { query, limit } = parsed;
      let names = deps.search(query, limit);
      const skillLines = deps.searchSkills?.(query) ?? [];
      const skillBlock =
        skillLines.length > 0
          ? `\n\nSkills (load with use_skill):\n${skillLines.join("\n")}`
          : "";
      if (names.length === 0 && deps.awaitPendingConnections !== undefined) {
        // Tier 1 — miss while connectors start up: wait briefly, then
        // re-search so late-mounting tools land. Undefined means the wait
        // itself timed out.
        let stillPending = await racePendingCount(
          deps.awaitPendingConnections,
          deps.pendingWaitMs ?? TOOL_SEARCH_PENDING_WAIT_MS,
        );
        names = deps.search(query, limit);
        if (
          names.length === 0 &&
          (stillPending ?? 1) > 0 &&
          deps.hasReconnectingMatch?.(query) === true
        ) {
          // Tier 2 — a reconnecting server holds tools that could match: one
          // short extension for the redial to remount them, then a final
          // re-search. Needs-auth never qualifies, so a hung authorization
          // still answers within the tier-1 bound.
          stillPending = await racePendingCount(
            deps.awaitPendingConnections,
            TOOL_SEARCH_RECONNECT_WAIT_MS,
          );
          names = deps.search(query, limit);
        }
        if (names.length === 0 && (stillPending ?? 1) > 0) {
          const detail =
            stillPending === undefined
              ? "a connector may still be starting up"
              : stillPending === 1
                ? "1 connector is still connecting"
                : `${stillPending} connectors are still connecting`;
          return `No tools matched "${query}" yet — ${detail}. Retry this search shortly.${skillBlock}`;
        }
      }
      if (names.length === 0 && skillLines.length > 0) {
        return `No tools matched "${query}".${skillBlock}`;
      }
      if (names.length === 0) {
        return `No tools or skills matched "${query}". Try different keywords describing the capability.`;
      }
      // Ranked cards: the top TOOL_SEARCH_SCHEMA_CARDS include a compact
      // input schema and flush onto the next infer's advertised tail; the
      // rest are name + description (promote-on-execute still declares a
      // called name).
      const load = names.slice(0, TOOL_SEARCH_SCHEMA_CARDS);
      if (load.length > 0) deps.promote?.(load);
      const blocks = names.map((name, i) =>
        renderToolCard(deps.lookup(name), name, i < TOOL_SEARCH_SCHEMA_CARDS),
      );
      return `Matching tools — call a listed name to use it:\n\n${blocks.join("\n")}${skillBlock}`;
    },
  });
}
