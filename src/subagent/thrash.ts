/**
 * Pure near-budget wrap-up detection plus read/edit bookkeeping for dispatched
 * workers. Wired into SubAgentDirector via evaluateSubAgentStop.
 *
 * Re-read pressure is deliberately not a stop signal: the fingerprint period
 * detector in stop-policy.ts catches genuinely repeating read cycles on the
 * evidence that they repeat, and a raw re-read count cannot tell four reads
 * spread across real progress from four reads in a loop (CL-6936).
 *
 * readCounts feeds evaluateSubAgentStop's requireEvidence check (the
 * CritiqueDirector gate). Reads performed through run_shell count as evidence
 * there too (CL-6937) — the prompt prohibits shell file work, but a prompt
 * violation deserves a correction, not a verdict that the work never
 * happened. editedPaths is recorded purely for intervention-log diagnostics
 * (CL-6994 deleted the never-edited stop that used to consume it — no
 * salvage class is gated on it).
 */

import { isProductMutationTool, productMutationPaths } from "../agent/product-mutation-tools.js";
import { PATH_KEYED_READ_TOOLS, SEARCH_QUERY_TOOLS } from "../agent/tool-classification.js";
import { classifyShellFileEvidence } from "./shell-evidence.js";

/** Tunable thresholds for force-report detection. */
export interface ThrashConfig {
  /**
   * When turnsCompleted equals maxTurns - forceReportWithin and the worker is
   * still issuing tools, inject a one-shot wrap-up nudge.
   */
  forceReportWithin: number;
}

export const DEFAULT_THRASH_CONFIG: ThrashConfig = {
  forceReportWithin: 2,
};

/** Accumulated read/edit bookkeeping across turns (immutable snapshots). */
export interface ThrashState {
  readonly readCounts: ReadonlyMap<string, number>;
  readonly editedPaths: ReadonlySet<string>;
  readonly totalToolCalls: number;
}

export const EMPTY_THRASH_STATE: ThrashState = {
  readCounts: new Map(),
  editedPaths: new Set(),
  totalToolCalls: 0,
};

/** "report-forced" is a near-budget wrap-up-nudge signal, not a stop. */
export type ThrashStopReason = "report-forced";

/** Content block shape compatible with fingerprintToolCalls / inference turns. */
export interface ThrashToolCallBlock {
  type: string;
  name?: string;
  arguments?: unknown;
}

// list_dir is deliberately excluded: a repeated identical listing of the same
// directory is not the stuck read/search loop this bookkeeping watches for
// the way a repeated read_file or grep is (see tool-classification.ts).
const READ_TOOLS = PATH_KEYED_READ_TOOLS;
const SEARCH_TOOLS = SEARCH_QUERY_TOOLS;
const SHELL_TOOL = "run_shell";

function parseArgs(raw: unknown): Record<string, unknown> {
  let args: unknown = raw ?? {};
  if (typeof args === "string") {
    try {
      args = JSON.parse(args) as unknown;
    } catch {
      return {};
    }
  }
  if (args !== null && typeof args === "object" && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  return {};
}

function pathFromArgs(args: Record<string, unknown>): string | null {
  const path = args.path;
  return typeof path === "string" && path.length > 0 ? path : null;
}

function searchKey(name: string, args: Record<string, unknown>): string {
  const pattern =
    typeof args.pattern === "string"
      ? args.pattern
      : typeof args.query === "string"
        ? args.query
        : "";
  const path = typeof args.path === "string" ? args.path : "";
  return `${name}::${pattern}::${path}`;
}

/**
 * Read-tracking key for a path. Chunked reads (offset/limit set) key by chunk,
 * a whole-file read keys by path alone.
 */
function readKey(path: string, args: Record<string, unknown>): string {
  const { offset, limit } = args;
  if (offset === undefined && limit === undefined) return path;
  return `${path}::${String(offset ?? 0)}:${String(limit ?? "")}`;
}

/**
 * Advance read/edit bookkeeping from one turn's content (or an explicit tool
 * list). Only `tool_call` blocks are counted; path strings are used as given
 * (no resolve).
 */
export function nextThrashState(
  prev: ThrashState,
  content: readonly ThrashToolCallBlock[],
): ThrashState {
  let totalToolCalls = prev.totalToolCalls;
  let readCounts: Map<string, number> | null = null;
  let editedPaths: Set<string> | null = null;

  for (const block of content) {
    if (block.type !== "tool_call") continue;
    totalToolCalls += 1;
    const name = typeof block.name === "string" ? block.name : "";
    const args = parseArgs(block.arguments);
    const path = pathFromArgs(args);

    if (READ_TOOLS.has(name) && path !== null) {
      if (readCounts === null) readCounts = new Map(prev.readCounts);
      const key = readKey(path, args);
      readCounts.set(key, (readCounts.get(key) ?? 0) + 1);
    } else if (SEARCH_TOOLS.has(name)) {
      if (readCounts === null) readCounts = new Map(prev.readCounts);
      const key = searchKey(name, args);
      readCounts.set(key, (readCounts.get(key) ?? 0) + 1);
    } else if (name === SHELL_TOOL) {
      // Shell file reads are evidence too, or a worker that reads with cat/rg
      // falsely fails the CritiqueDirector requireEvidence gate (CL-6937).
      const command = args.command;
      if (typeof command === "string" && command.length > 0) {
        const evidence = classifyShellFileEvidence(command);
        if (evidence.reads.length > 0) {
          if (readCounts === null) readCounts = new Map(prev.readCounts);
          for (const key of evidence.reads) {
            readCounts.set(key, (readCounts.get(key) ?? 0) + 1);
          }
        }
      }
    } else if (isProductMutationTool(name)) {
      const paths = productMutationPaths(name, args);
      if (paths.length > 0) {
        if (editedPaths === null) editedPaths = new Set(prev.editedPaths);
        for (const edited of paths) editedPaths.add(edited);
      }
    }
  }

  if (totalToolCalls === prev.totalToolCalls && readCounts === null && editedPaths === null) {
    return prev;
  }

  return {
    readCounts: readCounts ?? prev.readCounts,
    editedPaths: editedPaths ?? prev.editedPaths,
    totalToolCalls,
  };
}

/**
 * True on the single turn forceReportWithin turns before the cap where the
 * leaf is still issuing tools — the signal to inject a wrap-up nudge, not a
 * stop. Fires only when that turn leaves at least one further turn before
 * maxTurns, so a small budget degrades straight to turn-budget instead of
 * spending its only turn on a nudge that never gets to run.
 */
export function thrashForceReport(
  turnsCompleted: number,
  maxTurns: number,
  hasToolCalls: boolean,
  config: ThrashConfig = DEFAULT_THRASH_CONFIG,
): boolean {
  if (!hasToolCalls) return false;
  if (maxTurns <= 0) return false;
  const within = Math.max(0, config.forceReportWithin);
  const threshold = maxTurns - within;
  if (threshold < 1 || threshold >= maxTurns) return false;
  return turnsCompleted === threshold;
}

function resolveConfig(partial?: Partial<ThrashConfig>): ThrashConfig {
  if (partial === undefined) return DEFAULT_THRASH_CONFIG;
  return {
    forceReportWithin: partial.forceReportWithin ?? DEFAULT_THRASH_CONFIG.forceReportWithin,
  };
}

/**
 * Pure force-report decision. Null means keep running (or defer to
 * evaluateSubAgentStop for tool-less / fingerprint / hard budget).
 * "report-forced" is a one-shot nudge signal, not a stop — the caller injects
 * a wrap-up nudge and keeps running.
 *
 * Only evaluates when hasToolCalls is true.
 */
export function evaluateThrashStop(input: {
  hasToolCalls: boolean;
  turnsCompleted: number;
  maxTurns: number;
  config?: Partial<ThrashConfig>;
}): ThrashStopReason | null {
  if (!input.hasToolCalls) return null;
  const config = resolveConfig(input.config);
  if (thrashForceReport(input.turnsCompleted, input.maxTurns, input.hasToolCalls, config)) {
    return "report-forced";
  }
  return null;
}
