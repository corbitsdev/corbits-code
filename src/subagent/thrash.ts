/**
 * Pure progressive thrash detection for leaf sub-agents.
 *
 * Tracks re-read pressure and near-budget tools-only spin without requiring
 * identical tool fingerprints. Wired into SubAgentDirector via evaluateSubAgentStop.
 *
 * Precedence when both thrash signals and existing stop helpers apply:
 * no-progress > thrash > report-forced > turn-budget.
 * Tool-less turns stay owned by evaluateSubAgentStop (complete / never-acted).
 */


/** Tunable thresholds for thrash / force-report detection. */
export type ThrashConfig = {
  /** Same path read this many times triggers re-read pressure. */
  reReadLimit: number;
  /**
   * Without a prior edit of the path, re-read pressure also requires at least
   * this many total tool calls in the run (keeps multi-chunk legitimate reads
   * and multi-file explore from tripping early).
   */
  reReadMinTotalTools: number;
  /**
   * When turnsCompleted >= maxTurns - forceReportWithin and the leaf is still
   * issuing tools, force a salvage report turn.
   */
  forceReportWithin: number;
};

/** Conservative defaults: 20 unique single-path reads must not thrash. */
export const DEFAULT_THRASH_CONFIG: ThrashConfig = {
  reReadLimit: 4,
  reReadMinTotalTools: 8,
  forceReportWithin: 2,
};

/** Accumulated thrash bookkeeping across turns (immutable snapshots). */
export type ThrashState = {
  readonly readCounts: ReadonlyMap<string, number>;
  readonly editedPaths: ReadonlySet<string>;
  readonly totalToolCalls: number;
};

export const EMPTY_THRASH_STATE: ThrashState = {
  readCounts: new Map(),
  editedPaths: new Set(),
  totalToolCalls: 0,
};

/** Distinct stop reasons for parent hints / salvage (not yet on SubAgentStopReason). */
export type ThrashStopReason = "thrash" | "report-forced";

/** Content block shape compatible with fingerprintToolCalls / inference turns. */
export type ThrashToolCallBlock = {
  type: string;
  name?: string;
  arguments?: unknown;
};

const READ_TOOLS = new Set(["read_file"]);
const EDIT_TOOLS = new Set(["edit_file", "write_file", "delete_file"]);

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

/**
 * Advance thrash bookkeeping from one turn's content (or an explicit tool list).
 * Only `tool_call` blocks are counted; path strings are used as given (no resolve).
 */
export function nextThrashState(
  prev: ThrashState,
  content: ReadonlyArray<ThrashToolCallBlock>,
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
    if (path === null) continue;

    if (READ_TOOLS.has(name)) {
      if (readCounts === null) readCounts = new Map(prev.readCounts);
      readCounts.set(path, (readCounts.get(path) ?? 0) + 1);
    } else if (EDIT_TOOLS.has(name)) {
      if (editedPaths === null) editedPaths = new Set(prev.editedPaths);
      editedPaths.add(path);
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

/** True when re-read pressure indicates progressive thrash. */
export function thrashFromReRead(
  state: ThrashState,
  config: ThrashConfig = DEFAULT_THRASH_CONFIG,
): boolean {
  const { reReadLimit, reReadMinTotalTools } = config;
  for (const [path, count] of state.readCounts) {
    if (count < reReadLimit) continue;
    // Primary: re-read after edit of the same path.
    if (state.editedPaths.has(path)) return true;
    // Secondary: heavy re-read of one path amid enough total tool activity.
    if (state.totalToolCalls >= reReadMinTotalTools) return true;
  }
  return false;
}

/** True when the leaf is still calling tools within forceReportWithin of the cap. */
export function thrashForceReport(
  turnsCompleted: number,
  maxTurns: number,
  hasToolCalls: boolean,
  config: ThrashConfig = DEFAULT_THRASH_CONFIG,
): boolean {
  if (!hasToolCalls) return false;
  if (maxTurns <= 0) return false;
  const within = Math.max(0, config.forceReportWithin);
  return turnsCompleted >= maxTurns - within;
}

function resolveConfig(partial?: Partial<ThrashConfig>): ThrashConfig {
  if (partial === undefined) return DEFAULT_THRASH_CONFIG;
  return {
    reReadLimit: partial.reReadLimit ?? DEFAULT_THRASH_CONFIG.reReadLimit,
    reReadMinTotalTools:
      partial.reReadMinTotalTools ?? DEFAULT_THRASH_CONFIG.reReadMinTotalTools,
    forceReportWithin: partial.forceReportWithin ?? DEFAULT_THRASH_CONFIG.forceReportWithin,
  };
}

/**
 * Pure thrash / force-report stop decision. Null means keep running (or defer
 * to evaluateSubAgentStop for tool-less / fingerprint / hard budget).
 *
 * Only evaluates when hasToolCalls is true — tool-less endings are not thrash.
 * Prefers thrash over report-forced when both apply.
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
  if (
    thrashForceReport(input.turnsCompleted, input.maxTurns, input.hasToolCalls, config)
  ) {
    return "report-forced";
  }
  return null;
}
