/**
 * Live progress for a dispatched sub-agent's pending row in the transcript,
 * and the fleet-level roll-up of those same lanes.
 *
 * A "task" tool call renders as one row for its whole lifetime (see
 * `runtime-bridge.ts`'s `syncAgentProgress`). While the call is outstanding
 * this fills in what a bare pending mark cannot say: how long the worker has
 * been running, what it is doing right now, and whether it has gone quiet
 * long enough to look hung rather than merely slow.
 *
 * Lane state and the fleet roll-up live in this one file on purpose. "Stalled"
 * has exactly one definition — `laneState` below — and the fleet summary
 * consumes it rather than re-deriving staleness from raw timestamps.
 */

/** Minimal session shape this module reads — avoids a hard dep on the store. */
export interface AgentProgressSession {
  readonly status: "running" | "done" | "failed" | "cancelled";
  /** Present when the strip knows lifecycle independently of TUI status. */
  readonly lifecycleStatus?:
    "pending_init" | "running" | "interrupted" | "completed" | "shutdown" | "not_found";
  readonly currentToolName: string | null;
  /**
   * Bounded subject of the oldest outstanding call (command, path, pattern…),
   * or null when the args have nothing meaningful to show. When set, this
   * replaces the bare tool name in the row trailer so a fleet of shell
   * commands is distinguishable (CL-5765).
   */
  readonly currentToolPreview: string | null;
  /**
   * When the oldest outstanding tool call began, or null when none is in
   * flight. Required, not optional: every hop from the store to a surface is a
   * chance to drop it, and a dropped field would silently reclassify a busy
   * lane as stalled. A compile error is a better guard than a test.
   */
  readonly currentToolStartedAt: number | null;
  readonly startedAt: number;
  readonly lastActivityAt: number;
}

/**
 * What a lane is actually doing, as opposed to how long it has been alive.
 *
 * `in_tool` is the state that makes the surface honest: a worker inside one
 * long tool call emits nothing for the whole execution, so silence on its own
 * cannot tell a wedged reactor from a ten-minute test run. A lane only reads
 * `stalled` when it has gone quiet with no tool outstanding to explain it —
 * that is the case an operator can act on.
 */
export type LaneState = "working" | "in_tool" | "stalled";

export interface AgentProgress {
  /** Dim trailer painted after the row's subject, e.g. "0:42 · grep". */
  readonly stat: string;
  readonly state: LaneState;
  /** True while the worker is making visible progress. */
  readonly working: boolean;
  /** True once silence has run longer than the stall window with nothing to explain it. */
  readonly stalled: boolean;
}

/**
 * Silence after which a running worker reads as hung rather than thinking.
 *
 * Grok on the Responses path routinely sits 60–120s (sometimes longer) between
 * tool cycles with only sparse reasoning-summary deltas — billing thinking
 * tokens the whole time. A 2-minute bar painted those healthy gaps as stalled
 * Task rows and drove dig/cascade thrash. Align with the 5-minute sub-agent
 * stall nudge so UI and salvage agree on what "quiet too long" means.
 */
export const DEFAULT_STALL_MS = 300_000;

/**
 * Second, far longer bound: how long one tool call may stay outstanding before
 * the lane reads as stalled anyway.
 *
 * Without it `in_tool` would be terminal — a wedged build, a shell blocked on
 * stdin, or a deadlocked child would read as busy forever and never reach the
 * fleet stall count, trading a false-positive storm for a false negative on the
 * failure operators most need to see. It is deliberately generous: real test
 * suites and builds run for minutes, and crying stall over those is the defect
 * this surface was fixed to remove.
 *
 * It also backstops calls that never report a result at all. The reactor's
 * approval-suspend path emits no completion, so a before-tool extension
 * returning suspend would leave a call outstanding permanently. Nothing
 * registers such an extension today, but this bound means it degrades to a
 * late stall rather than a lane that never stops looking busy.
 */
export const IN_TOOL_STALL_MS = 600_000;

/** "m:ss" — compact enough to sit in a row's dim trailer alongside a tool name. */
export function clockLabel(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * The single definition of what a lane is doing. Every other surface — the
 * transcript trailer, the agents panel, the top-level indicator — reads this
 * result rather than comparing timestamps itself.
 */
export function laneState(
  session: AgentProgressSession,
  nowMs: number,
  stallMs: number = DEFAULT_STALL_MS,
  inToolStallMs: number = IN_TOOL_STALL_MS,
): LaneState {
  if (nowMs - session.lastActivityAt < stallMs) return "working";
  const toolStartedAt = session.currentToolStartedAt;
  if (
    session.currentToolName !== null &&
    toolStartedAt !== null &&
    nowMs - toolStartedAt < inToolStallMs
  ) {
    return "in_tool";
  }
  return "stalled";
}

/**
 * Progress for a running session's pending row, or null once it has finished —
 * a terminal session resolves its row through the tool-result path instead.
 *
 * The number beside the state word always explains that word: a healthy lane
 * shows its lifetime, a lane stuck in one tool shows how long that tool has
 * been running, and a silent lane shows how long it has been silent. Reading
 * a lifetime clock next to "stalled" tells an operator nothing about the stall.
 */
export function agentProgress(
  session: AgentProgressSession,
  nowMs: number,
  stallMs: number = DEFAULT_STALL_MS,
): AgentProgress | null {
  if (session.status !== "running") return null;
  const elapsed = clockLabel(nowMs - session.startedAt);
  // Prefer the argument subject over the bare tool name — six shell commands
  // on a fleet board are six different situations, not six identical labels.
  const preview = session.currentToolPreview;
  const tool = session.currentToolName;
  const subject =
    preview !== null && preview.length > 0
      ? preview
      : tool !== null && tool.length > 0
        ? tool
        : null;
  const hasSubject = subject !== null;
  const state = laneState(session, nowMs, stallMs);

  if (session.lifecycleStatus === "interrupted") {
    const toolBit =
      hasSubject && session.currentToolName !== null ? ` · ${subject} still running` : "";
    return {
      stat: `interrupted${toolBit}`,
      state,
      working: false,
      stalled: false,
    };
  }

  const base = hasSubject ? `${elapsed} · ${subject}` : elapsed;
  // Never render "quiet" — operator chrome only shows motion (elapsed / tool).
  // Internal `state` still carries stalled for recovery consumers.
  const stat =
    state === "in_tool" && session.currentToolStartedAt !== null
      ? `${base} ${clockLabel(nowMs - session.currentToolStartedAt)}`
      : base;

  return {
    stat,
    state,
    working: state !== "stalled",
    stalled: state === "stalled",
  };
}

/**
 * What the whole fleet is doing, rolled up from the per-lane states above.
 *
 * The top-level indicator otherwise reports the parent's own activity, and at
 * fleet scale the parent is almost always just awaiting children — so it reads
 * "working" permanently, including while every lane is stuck. Counting lanes
 * here is what lets the indicator speak for the fleet instead.
 */
export interface FleetProgress {
  readonly running: number;
  readonly working: number;
  readonly inTool: number;
  readonly stalled: number;
}

export function fleetProgress(
  sessions: readonly AgentProgressSession[],
  nowMs: number,
  stallMs: number = DEFAULT_STALL_MS,
): FleetProgress {
  let working = 0;
  let inTool = 0;
  let stalled = 0;
  for (const session of sessions) {
    if (session.status !== "running") continue;
    switch (laneState(session, nowMs, stallMs)) {
      case "working":
        working += 1;
        break;
      case "in_tool":
        inTool += 1;
        break;
      case "stalled":
        stalled += 1;
        break;
    }
  }
  return { running: working + inTool + stalled, working, inTool, stalled };
}

/**
 * Compact fleet summary for the status ticker, or null with no live lanes —
 * with no sub-agents running the indicator must behave exactly as it does for
 * a plain single-agent turn.
 */
export function fleetLabel(fleet: FleetProgress): string | null {
  if (fleet.running === 0) return null;
  // Count only — never "stalled" / "quiet" for the operator.
  const parts = [`${fleet.running} agents`];
  if (fleet.stalled === 0 && fleet.inTool === fleet.running) {
    parts.push("in tools");
  }
  return parts.join(" · ");
}
