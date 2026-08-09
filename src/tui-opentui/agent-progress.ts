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
export type AgentProgressSession = {
  readonly status: "running" | "done" | "failed" | "cancelled";
  readonly currentToolName: string | null;
  /** When the outstanding tool call began, or null when none is in flight. */
  readonly currentToolStartedAt?: number | null;
  readonly startedAt: number;
  readonly lastActivityAt: number;
};

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

export type AgentProgress = {
  /** Dim trailer painted after the row's subject, e.g. "0:42 · grep". */
  readonly stat: string;
  readonly state: LaneState;
  /** True while the worker is making visible progress. */
  readonly working: boolean;
  /** True once silence has run longer than the stall window with nothing to explain it. */
  readonly stalled: boolean;
};

/** Silence after which a running worker reads as hung rather than thinking. */
export const DEFAULT_STALL_MS = 30_000;

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
): LaneState {
  if (nowMs - session.lastActivityAt < stallMs) return "working";
  const toolStartedAt = session.currentToolStartedAt;
  if (session.currentToolName !== null && toolStartedAt !== null && toolStartedAt !== undefined) {
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
  const tool = session.currentToolName;
  const hasTool = tool !== null && tool.length > 0;
  const state = laneState(session, nowMs, stallMs);

  const base = hasTool ? `${elapsed} · ${tool}` : elapsed;
  const stat =
    state === "in_tool" && session.currentToolStartedAt != null
      ? `${base} ${clockLabel(nowMs - session.currentToolStartedAt)}`
      : state === "stalled"
        ? `${base} · quiet ${clockLabel(nowMs - session.lastActivityAt)}`
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
export type FleetProgress = {
  readonly running: number;
  readonly working: number;
  readonly inTool: number;
  readonly stalled: number;
};

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
  const parts = [`${fleet.running} agents`];
  if (fleet.stalled > 0) parts.push(`${fleet.stalled} stalled`);
  else if (fleet.inTool === fleet.running) parts.push("in tools");
  return parts.join(" · ");
}
