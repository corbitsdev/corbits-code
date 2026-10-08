/**
 * Pre-spawn capability preflight for `spawn_agent(requires_tools=...)`.
 *
 * A `requires_tools` entry is a hard requirement: the named tool must be
 * mounted on the worker or the dispatch is rejected before any session,
 * telemetry, or worktree exists. Names are canonical engine ids on both
 * sides (aliases collapse via canonicalToolName), so `shell` and
 * `run_shell` are the same requirement. Fail-closed: unknown names and
 * allowlist/denylist misses reject.
 *
 * `stale_snapshot` is never emitted here — it is the mount-time echo in
 * run.ts (a tool stamped at dispatch is missing from the live mount). It
 * lives in this union so both paths share one formatter.
 */

import { canonicalToolName } from "../agent/canonical-tool-name.js";
import {
  DIRECTOR_REGISTRY,
  packageToCapabilities,
} from "../agent/directors/registry.js";
import type { CapabilityFilter } from "../agent/profile-types.js";
import { isMcpToolName } from "../mcp/tool-name.js";

export type CapabilityUnavailableCode =
  | "missing_tool"
  | "permission_static"
  | "missing_binary"
  | "stale_snapshot"
  | "unknown_tool";

export interface PreflightCapabilitiesInput {
  /** Raw requires_tools entries (aliases welcome — canonicalized here). */
  required: readonly string[];
  /** Resolved dispatch filter; undefined means full mount (everything passes). */
  resolvedFilter?: CapabilityFilter | undefined;
  /**
   * Canonical engine ids verifiable in this dispatch. Production always
   * passes the full catalog (DEFAULT_KNOWN_ENGINES); narrowed sets are a
   * test-only seam for simulating an incomplete runtime.
   */
  knownEngines: readonly string[];
  /**
   * Live inherited-MCP tools the parent session mounted
   * (`mcp__<server>__<tool>`). Presence passes the known-engine and
   * allowlist checks — run.ts retains only requested inherited MCP tools,
   * so presence proves the worker mounts it on demand. Absence rejects as
   * `unknown_tool`; availability is never inferred from name shape alone.
   */
  availableMcpTools?: readonly string[] | undefined;
  /** Worker label for messages (director id or profile id). */
  agentLabel: string;
}

export interface CapabilityUnavailable {
  code: CapabilityUnavailableCode;
  /** Canonical tool id (or the raw entry for unknown). */
  tool: string;
  /** Every missing tool, for the multi-missing stale_snapshot echo. */
  tools?: readonly string[];
  /** Nearest known name, for the unknown_tool typo guard. */
  suggestion?: string;
  /** Spawnable directors that mount the tool, for reroute hints. */
  alternatives?: readonly string[];
  /**
   * Extra fact sentence for missing_tool, naming a mount restriction the
   * allowlist framing cannot see — e.g. a tier gate that withholds fleet
   * verbs from leaves. Rendered between the fact and the action sentence.
   */
  detail?: string;
}

export type CapabilityPreflightResult =
  | { ok: true; canonical: string[] }
  | { ok: false; unavailable: CapabilityUnavailable };

/**
 * Canonical engine ids the fleet knows how to mount: the director tool
 * surfaces plus the worker/plumbing verbs mounted outside capability
 * filters. Dispatch passes this as `knownEngines`.
 */
export const KNOWN_CAPABILITY_ENGINES: readonly string[] = [
  "read_file",
  "write_file",
  "edit_file",
  "delete_file",
  "run_shell",
  "grep",
  "search_files",
  "list_dir",
  "lsp",
  "web_fetch",
  "web_search",
  "skill_search",
  "use_skill",
  "manage_tasks",
  "spawn_agent",
  "list_agents",
  "close_agent",
  "resume_agent",
  "interrupt_agent",
  "send_input",
  "read_agent_trace",
  "search_agents",
  "ask_director",
  "submit_result",
];

/**
 * Dispatch-time `knownEngines`: the full catalog, so `missing_binary` never
 * fires in production. Narrowed sets are a test-only seam for simulating an
 * incomplete runtime — production probes no binaries (most engines are
 * in-process).
 */
export const DEFAULT_KNOWN_ENGINES: readonly string[] =
  KNOWN_CAPABILITY_ENGINES;

/**
 * Engines mounted outside the capability filter (run.ts appends
 * manage_tasks after filtering, and mounts the Tier 3 leaf channel
 * submit_result/ask_director when tier is "leaf"), so requires_tools
 * entries for them pass even a narrow allowlist. update_plan
 * canonicalizes here and rides the same exemption; the mount-time echo
 * runs after all appends, so the stamped entry matches the live mount.
 * Fail-closed: the tier gate in agent-fleet.ts still rejects these on
 * non-leaf tiers.
 */
const POST_FILTER_MOUNTED_ENGINES: readonly string[] = [
  "manage_tasks",
  "submit_result",
  "ask_director",
];

/** Alias spellings accepted in requires_tools, for typo suggestions. */
const SUGGESTION_CANDIDATES: readonly string[] = [
  ...KNOWN_CAPABILITY_ENGINES,
  "read",
  "write",
  "edit",
  "delete",
  "bash",
  "glob",
  "shell",
  "update_plan",
];

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] ?? 0;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const above = (prev[j] ?? 0) + 1;
      const left = (prev[j - 1] ?? 0) + 1;
      const next = Math.min(above, left, diag + cost);
      diag = prev[j] ?? 0;
      prev[j] = next;
    }
  }
  return prev[b.length] ?? Number.MAX_SAFE_INTEGER;
}

function nearestToolName(raw: string): string | undefined {
  // MCP names (`mcp__<server>__<tool>`) live outside the built-in catalog —
  // a typo hint against built-ins would mislead, so MCP-shaped input never
  // gets a suggestion.
  if (isMcpToolName(raw.trim())) return undefined;
  const lower = raw.toLowerCase();
  let best: string | undefined;
  let bestDistance = Number.MAX_SAFE_INTEGER;
  for (const candidate of SUGGESTION_CANDIDATES) {
    const distance = levenshtein(lower, candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best !== undefined && bestDistance <= 2 ? best : undefined;
}

/**
 * Spawnable directors (closed set minus primary dispatch) whose mounted
 * tool set includes `canonical`, derived from packageToCapabilities over
 * DIRECTOR_REGISTRY so the hint tracks the envelopes. Sorted before the
 * cap, so the three named come first alphabetically.
 */
export function rerouteAlternatives(canonical: string): readonly string[] {
  const want = canonicalToolName(canonical);
  const out: string[] = [];
  for (const pkg of Object.values(DIRECTOR_REGISTRY)) {
    if (pkg.id === "dispatch") continue;
    const capabilities = packageToCapabilities(pkg);
    if (capabilities === undefined) {
      out.push(pkg.id);
    } else if (capabilities.mode === "allow") {
      if (capabilities.tools.some((t) => canonicalToolName(t) === want)) {
        out.push(pkg.id);
      }
    } else if (!capabilities.tools.some((t) => canonicalToolName(t) === want)) {
      out.push(pkg.id);
    }
  }
  return out.sort().slice(0, 3);
}

/**
 * Tier-3 leaf directors (closed set, dispatch excluded) for the tier-gate
 * hint when requires_tools names the leaf reporting channel on a non-leaf
 * tier. submit_result/ask_director mount post-filter, so no envelope
 * mentions them and rerouteAlternatives would report none; this names the
 * directors that actually mount them.
 */
export function leafTierAlternatives(): readonly string[] {
  return Object.values(DIRECTOR_REGISTRY)
    .filter((pkg) => pkg.id !== "dispatch" && pkg.tier === "leaf")
    .map((pkg) => pkg.id)
    .sort()
    .slice(0, 3);
}

export function preflightCapabilities(
  input: PreflightCapabilitiesInput,
): CapabilityPreflightResult {
  const { resolvedFilter, knownEngines } = input;
  const known = new Set(knownEngines.map((name) => canonicalToolName(name)));
  const liveMcp = new Set(
    (input.availableMcpTools ?? []).map((name) => canonicalToolName(name)),
  );
  const allow =
    resolvedFilter?.mode === "allow"
      ? new Set(resolvedFilter.tools.map((name) => canonicalToolName(name)))
      : undefined;
  const deny =
    resolvedFilter?.mode === "exclude"
      ? new Set(resolvedFilter.tools.map((name) => canonicalToolName(name)))
      : undefined;
  const postFilter = new Set(POST_FILTER_MOUNTED_ENGINES);
  const catalog = new Set(KNOWN_CAPABILITY_ENGINES);
  const seen = new Set<string>();
  const canonical: string[] = [];
  for (const raw of input.required) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return { ok: false, unavailable: { code: "unknown_tool", tool: raw } };
    }
    const engine = canonicalToolName(trimmed);
    // A live inherited-MCP tool passes the catalog check — presence proves
    // the worker mounts it on demand; shape alone proves nothing, so an
    // `mcp__*` name outside the live set still rejects below.
    const isLiveMcp = isMcpToolName(engine) && liveMcp.has(engine);
    if (!catalog.has(engine) && !isLiveMcp) {
      const suggestion = nearestToolName(trimmed);
      return {
        ok: false,
        unavailable: {
          code: "unknown_tool",
          tool: trimmed,
          ...(suggestion !== undefined ? { suggestion } : {}),
        },
      };
    }
    if (!isLiveMcp && !known.has(engine)) {
      return {
        ok: false,
        unavailable: { code: "missing_binary", tool: engine },
      };
    }
    if (!postFilter.has(engine) && !isLiveMcp) {
      if (allow !== undefined && !allow.has(engine)) {
        return {
          ok: false,
          unavailable: {
            code: "missing_tool",
            tool: engine,
            alternatives: rerouteAlternatives(engine),
          },
        };
      }
      if (deny !== undefined && deny.has(engine)) {
        return {
          ok: false,
          unavailable: {
            code: "permission_static",
            tool: engine,
            alternatives: rerouteAlternatives(engine),
          },
        };
      }
    } else if (isLiveMcp && deny !== undefined && deny.has(engine)) {
      // An explicit exclude naming a live MCP tool still withholds it —
      // run.ts strips named tools in exclude mode, so the mount would drop
      // it and the requirement must reject here, not as a stale snapshot.
      return {
        ok: false,
        unavailable: {
          code: "permission_static",
          tool: engine,
          alternatives: rerouteAlternatives(engine),
        },
      };
    }
    if (!seen.has(engine)) {
      seen.add(engine);
      canonical.push(engine);
    }
  }
  return { ok: true, canonical };
}

/**
 * Mount-time echo helper (run.ts): the stamped dispatch requirements against
 * the live mount. A missing stamped tool means the capability snapshot went
 * stale between dispatch and mount — never a dispatch-time outcome.
 */
export function checkMountedRequiresTools(
  stampedRequires: readonly string[],
  mountedToolNames: readonly string[],
): { ok: true } | { ok: false; missing: string[] } {
  const mounted = new Set(
    mountedToolNames.map((name) => canonicalToolName(name)),
  );
  const missing = stampedRequires.filter(
    (name) => !mounted.has(canonicalToolName(name)),
  );
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

/**
 * One user message per code. Every message ends in exactly one next-action
 * sentence — the caller re-dispatches deliberately; there is no auto
 * re-dispatch, successor, or retry.
 */
export function formatCapabilityUnavailable(
  unavailable: CapabilityUnavailable,
  agentLabel: string,
): string {
  const alternatives =
    unavailable.alternatives !== undefined &&
    unavailable.alternatives.length > 0
      ? ` Re-dispatch to one of (${unavailable.alternatives.join(", ")}) or drop the requirement.`
      : ` No spawnable director mounts "${unavailable.tool}" — drop the requirement or add a profile that mounts it.`;
  switch (unavailable.code) {
    case "missing_tool": {
      const detail =
        unavailable.detail !== undefined ? ` ${unavailable.detail}.` : "";
      return (
        `Error: worker "${agentLabel}" requires tool "${unavailable.tool}" but its capability allowlist omits it.` +
        detail +
        alternatives
      );
    }
    case "permission_static":
      return (
        `Error: worker "${agentLabel}" requires tool "${unavailable.tool}" but its capability denylist blocks it.` +
        alternatives
      );
    case "missing_binary":
      return (
        `Error: worker "${agentLabel}" requires tool "${unavailable.tool}" but this dispatch cannot verify its runtime engine (not in the dispatch's known-engine set). ` +
        `Re-dispatch without requires_tools=["${unavailable.tool}"] or drop the requirement.`
      );
    case "stale_snapshot": {
      const missing = unavailable.tools ?? [unavailable.tool];
      return (
        `Error: stale_snapshot setup_error (non-continuable) — worker "${agentLabel}" was dispatched requiring "${missing.join('", "')}" but the live mount no longer provides ${missing.length === 1 ? "it" : "them"}. ` +
        `Re-dispatch the worker deliberately with a fresh brief instead of retrying in place.`
      );
    }
    case "unknown_tool": {
      const hint =
        unavailable.suggestion !== undefined
          ? ` Did you mean "${unavailable.suggestion}"?`
          : "";
      return (
        `Error: worker "${agentLabel}" requires unknown tool "${unavailable.tool}".${hint} ` +
        `Correct requires_tools to a canonical tool name and re-dispatch.`
      );
    }
  }
}
