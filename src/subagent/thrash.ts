/**
 * Pure progressive thrash detection for dispatched workers.
 *
 * Tracks re-read pressure (same path or same grep) and near-budget tools-only
 * spin. No look-volume quota — unique reads are legal at any count.
 * Wired into SubAgentDirector via evaluateSubAgentStop.
 *
 * Precedence: no-progress > thrash > turn-budget. Soft re-read-nudge and
 * report-forced are one-shot wrap-up / redirect nudges, not stops.
 */

import { isProductMutationTool, productMutationPaths } from "../agent/product-mutation-tools.js";

/** Tunable thresholds for thrash / force-report detection. */
export interface ThrashConfig {
  /** Same path read this many times triggers hard re-read thrash stop. */
  reReadLimit: number;
  /**
   * Soft re-read pressure threshold (must be < reReadLimit). Crossing it injects
   * a one-shot mid-run nudge without stopping the leaf; hard thrash still fires
   * if the leaf keeps re-reading past reReadLimit.
   */
  reReadSoftLimit: number;
  /**
   * Without a prior edit of the path, re-read pressure also requires at least
   * this many total tool calls in the run (keeps multi-chunk legitimate reads
   * and multi-file explore from tripping early).
   */
  reReadMinTotalTools: number;
  /**
   * When turnsCompleted equals maxTurns - forceReportWithin and the worker is
   * still issuing tools, inject a one-shot wrap-up nudge.
   */
  forceReportWithin: number;
}

/** Conservative defaults: 20 unique single-path reads must not thrash. */
export const DEFAULT_THRASH_CONFIG: ThrashConfig = {
  reReadLimit: 4,
  reReadSoftLimit: 3,
  reReadMinTotalTools: 8,
  forceReportWithin: 2,
};

/** Accumulated thrash bookkeeping across turns (immutable snapshots). */
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

/**
 * Thrash-module stop reasons.
 * - "thrash" is a real stop (same-path / same-grep re-read)
 * - "report-forced" is a near-budget wrap-up-nudge signal
 * - "re-read-nudge" is a mid-run redirect (one-shot, not a stop)
 */
export type ThrashStopReason = "thrash" | "report-forced" | "re-read-nudge";

/** Content block shape compatible with fingerprintToolCalls / inference turns. */
export interface ThrashToolCallBlock {
  type: string;
  name?: string;
  arguments?: unknown;
}

const READ_TOOLS = new Set(["read_file"]);
const SEARCH_TOOLS = new Set(["grep", "search_files"]);

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
 * Re-read tracking key for a path. Chunked reads (offset/limit set) key by
 * chunk so paging through a large file does not look like re-reading the same
 * span; a whole-file read keys by path alone.
 */
function readKey(path: string, args: Record<string, unknown>): string {
  const { offset, limit } = args;
  if (offset === undefined && limit === undefined) return path;
  return `${path}::${String(offset ?? 0)}:${String(limit ?? "")}`;
}

/** True when a read-tracking key belongs to the given path (any chunk). */
function keyBelongsToPath(key: string, path: string): boolean {
  return key === path || key.startsWith(`${path}::`);
}

/** Drop every read-count entry (all chunk keys) for a path that was just edited. */
function decayReadsForPath(readCounts: Map<string, number>, path: string): void {
  for (const key of readCounts.keys()) {
    if (keyBelongsToPath(key, path)) readCounts.delete(key);
  }
}

/**
 * Advance thrash bookkeeping from one turn's content (or an explicit tool list).
 * Only `tool_call` blocks are counted; path strings are used as given (no resolve).
 * An edit decays prior read pressure on its path — the file changed, so earlier
 * reads no longer count toward re-read thrash.
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
    } else if (isProductMutationTool(name)) {
      const paths = productMutationPaths(name, args);
      if (paths.length > 0) {
        if (editedPaths === null) editedPaths = new Set(prev.editedPaths);
        if (readCounts === null) readCounts = new Map(prev.readCounts);
        for (const edited of paths) {
          editedPaths.add(edited);
          decayReadsForPath(readCounts, edited);
        }
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
 * True when any path's re-read count meets `limit` and total tool volume clears
 * the min-tools gate. Shared by hard thrash and soft re-read-nudge.
 */
function reReadPressureAt(state: ThrashState, limit: number, minTotalTools: number): boolean {
  if (state.totalToolCalls < minTotalTools) return false;
  for (const count of state.readCounts.values()) {
    if (count >= limit) return true;
  }
  return false;
}

/**
 * True when re-read pressure indicates progressive thrash. Gated on total
 * tool volume regardless of whether the path was edited — an ordinary
 * edit-then-verify loop decays its read count on each edit (see
 * decayReadsForPath) and so rarely reaches reReadLimit at all, but the volume
 * gate is a second line of defense against classifying a low-activity run as
 * thrash from re-read count alone.
 */
export function thrashFromReRead(
  state: ThrashState,
  config: ThrashConfig = DEFAULT_THRASH_CONFIG,
): boolean {
  return reReadPressureAt(state, config.reReadLimit, config.reReadMinTotalTools);
}

/**
 * True when re-read pressure has crossed the soft threshold but not yet hard
 * thrash. Used to inject a one-shot mid-run redirect before the leaf burns
 * the rest of its budget re-reading the same paths.
 */
export function thrashSoftReRead(
  state: ThrashState,
  config: ThrashConfig = DEFAULT_THRASH_CONFIG,
): boolean {
  const soft = Math.min(config.reReadSoftLimit, config.reReadLimit - 1);
  if (soft < 1) return false;
  if (thrashFromReRead(state, config)) return false;
  return reReadPressureAt(state, soft, config.reReadMinTotalTools);
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
    reReadLimit: partial.reReadLimit ?? DEFAULT_THRASH_CONFIG.reReadLimit,
    reReadSoftLimit: partial.reReadSoftLimit ?? DEFAULT_THRASH_CONFIG.reReadSoftLimit,
    reReadMinTotalTools: partial.reReadMinTotalTools ?? DEFAULT_THRASH_CONFIG.reReadMinTotalTools,
    forceReportWithin: partial.forceReportWithin ?? DEFAULT_THRASH_CONFIG.forceReportWithin,
  };
}

/**
 * Pure thrash / force-report / soft re-read decision. Null means keep running
 * (or defer to evaluateSubAgentStop for tool-less / fingerprint / hard budget).
 * "thrash" is a real stop; "report-forced" and "re-read-nudge" are one-shot
 * nudge signals, not stops — the caller injects a nudge and keeps running.
 *
 * Only evaluates when hasToolCalls is true — tool-less endings are not thrash.
 * Prefers thrash > report-forced > re-read-nudge.
 */
export function evaluateThrashStop(input: {
  state: ThrashState;
  hasToolCalls: boolean;
  turnsCompleted: number;
  maxTurns: number;
  config?: Partial<ThrashConfig>;
}): ThrashStopReason | null {
  if (!input.hasToolCalls) return null;
  const config = resolveConfig(input.config);
  if (thrashFromReRead(input.state, config)) return "thrash";
  if (thrashForceReport(input.turnsCompleted, input.maxTurns, input.hasToolCalls, config)) {
    return "report-forced";
  }
  if (thrashSoftReRead(input.state, config)) return "re-read-nudge";
  return null;
}
