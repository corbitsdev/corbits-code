/**
 * Pre-spawn capability preflight for `spawn_agent(requires_tools=...)` (CL-9476).
 *
 * A `requires_tools` entry is a hard requirement: the named tool must be
 * mounted on the worker or the dispatch is rejected before any session,
 * telemetry, or worktree exists. Names are canonical engine ids on both sides
 * (wire/hidden aliases collapse via canonicalToolName), so `shell` and
 * `run_shell` are the same requirement. Fail-closed throughout: unknown names,
 * unverifiable profiles, and absent binaries all reject.
 *
 * The `stale_snapshot` code is never emitted by preflightCapabilities — it is
 * the mount-time echo in run.ts (a tool stamped at dispatch is missing from
 * the live mount). It lives in this union so both paths share one formatter.
 */

import { canonicalToolName } from "../agent/canonical-tool-name.js";
import {
  DIRECTOR_REGISTRY,
  packageToCapabilities,
} from "../agent/directors/registry.js";
import type { CapabilityFilter } from "../agent/profile-types.js";

export type CapabilityUnavailableCode =
  | "missing_tool"
  | "permission_static"
  | "missing_binary"
  | "stale_snapshot"
  | "malformed_profile"
  | "unknown_tool";

export interface CapabilityProfileSource {
  /** Directory or file the dispatched profile was loaded from, for messages. */
  path?: string;
  /** True when the profile file failed to parse/validate — unverifiable. */
  malformed?: boolean;
  /** Loader's reason for the malformed flag, for messages. */
  reason?: string;
}

export interface PreflightCapabilitiesInput {
  /** Raw requires_tools entries (aliases welcome — canonicalized here). */
  required: readonly string[];
  /** Resolved dispatch filter; undefined means full mount (everything passes). */
  resolvedFilter?: CapabilityFilter | undefined;
  /** Canonical engine ids available in this runtime (binary-present). */
  knownEngines: readonly string[];
  /** Worker label for messages (director id or profile id). */
  agentLabel: string;
  /** Profile provenance; a malformed source fails closed. */
  profileSource?: CapabilityProfileSource;
}

export interface CapabilityUnavailable {
  code: CapabilityUnavailableCode;
  /** Canonical tool id (or the raw entry for unknown/malformed). */
  tool: string;
  /** Nearest known name, for the unknown_tool typo guard. */
  suggestion?: string;
  /** Spawnable directors that mount the tool, for reroute hints. */
  alternatives?: readonly string[];
}

export type CapabilityPreflightResult =
  | { ok: true; canonical: string[] }
  | { ok: false; unavailable: CapabilityUnavailable };

/**
 * Canonical engine ids the fleet knows how to mount: the director tool
 * surfaces plus the worker/plumbing verbs mounted outside capability
 * filters. Dispatch passes this as `knownEngines`; tests inject narrower
 * sets to simulate an absent binary.
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
  "shell_collect",
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

/** Production `knownEngines`: every known engine is binary-present. */
export const DEFAULT_KNOWN_ENGINES: readonly string[] =
  KNOWN_CAPABILITY_ENGINES;

/**
 * Engines mounted outside the capability filter (run.ts mounts manage_tasks
 * after filtering), so a requires_tools entry for them passes preflight even
 * when the dispatch filter is a narrow allowlist.
 */
const POST_FILTER_MOUNTED_ENGINES: readonly string[] = ["manage_tasks"];

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
 * Spawnable directors (closed set minus primary skywalker) whose mounted
 * tool set includes `canonical` — derived from packageToCapabilities over
 * DIRECTOR_REGISTRY, so the hint tracks the envelopes. Capped for messages.
 */
export function rerouteAlternatives(canonical: string): readonly string[] {
  const want = canonicalToolName(canonical);
  const out: string[] = [];
  for (const pkg of Object.values(DIRECTOR_REGISTRY)) {
    if (pkg.id === "skywalker") continue;
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
    if (out.length >= 3) break;
  }
  return out.sort();
}

export function preflightCapabilities(
  input: PreflightCapabilitiesInput,
): CapabilityPreflightResult {
  const { resolvedFilter, knownEngines, profileSource } = input;
  if (profileSource?.malformed === true) {
    return {
      ok: false,
      unavailable: {
        code: "malformed_profile",
        tool: profileSource.path ?? "(profile source)",
        ...(profileSource.reason !== undefined
          ? { suggestion: profileSource.reason }
          : {}),
      },
    };
  }
  const known = new Set(knownEngines.map((name) => canonicalToolName(name)));
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
    if (!catalog.has(engine)) {
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
    if (!known.has(engine)) {
      return {
        ok: false,
        unavailable: { code: "missing_binary", tool: engine },
      };
    }
    if (!postFilter.has(engine)) {
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
 * re-dispatch, successor, or retry path.
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
    case "missing_tool":
      return (
        `Error: worker "${agentLabel}" requires tool "${unavailable.tool}" but its capability allowlist omits it.` +
        alternatives
      );
    case "permission_static":
      return (
        `Error: worker "${agentLabel}" requires tool "${unavailable.tool}" but its capability denylist blocks it.` +
        alternatives
      );
    case "missing_binary":
      return (
        `Error: worker "${agentLabel}" requires tool "${unavailable.tool}" but its runtime engine is unavailable in this environment. ` +
        `Re-dispatch without requires_tools=["${unavailable.tool}"] or install the backing runtime first.`
      );
    case "stale_snapshot":
      return (
        `Error: stale_snapshot setup_error (non-continuable) — worker "${agentLabel}" was dispatched requiring "${unavailable.tool}" but the live mount no longer provides it. ` +
        `Re-dispatch the worker deliberately with a fresh brief instead of retrying in place.`
      );
    case "malformed_profile": {
      const reason =
        unavailable.suggestion !== undefined
          ? ` (${unavailable.suggestion})`
          : "";
      return (
        `Error: worker "${agentLabel}" cannot verify requires_tools — profile source "${unavailable.tool}" is malformed${reason}, so capabilities fail closed. ` +
        `Fix the profile file and re-dispatch deliberately.`
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
