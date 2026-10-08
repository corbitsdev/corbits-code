/**
 * Live progress for a dispatched sub-agent's pending transcript row, plus the
 * fleet roll-up.
 *
 * The pending row lives for the worker's lifetime, not just the tool call —
 * the immediate `{status:running}` result must not drop live clocks. Lane and
 * fleet share one stalled definition (`laneState`).
 */

/** Minimal session shape this module reads — avoids a hard dep on the store. */
export interface AgentProgressSession {
  readonly status: "running" | "done" | "failed" | "cancelled";
  /** Present when the strip knows lifecycle independently of TUI status. */
  readonly lifecycleStatus?:
    | "pending_init"
    | "running"
    | "interrupted"
    | "completed"
    | "shutdown"
    | "not_found";
  readonly currentToolName: string | null;
  /** Bounded subject of the oldest outstanding call, or null when the args
   * have nothing to show. Replaces the bare tool name so shell commands
   * stay distinguishable. */
  readonly currentToolPreview: string | null;
  /** When the oldest outstanding tool call began, or null when none is in
   * flight. Required: dropping it silently reclassifies a busy lane as
   * stalled. */
  readonly currentToolStartedAt: number | null;
  readonly startedAt: number;
  readonly lastActivityAt: number;
  /** False while admission-queued (pending_init, run not started). Missing
   * means unknown — treat as in-flight for stall. */
  readonly runInFlight?: boolean;
}

/**
 * What a lane is doing, not how long it has been alive.
 *
 * A worker in one long tool call emits nothing, so silence alone cannot
 * tell a wedged reactor from a long test run. `stalled` is quiet with no
 * outstanding tool to explain it — the only case an operator can act on.
 */
export type LaneState = "queued" | "working" | "in_tool" | "stalled";

export interface AgentProgress {
  /** Dim trailer painted after the row's subject, e.g. "0:42 · grep". */
  readonly stat: string;
  readonly state: LaneState;
  /** True while the worker is making visible progress. */
  readonly working: boolean;
  /** True once silence outlasted the stall window with nothing to
   * explain it. */
  readonly stalled: boolean;
}

/**
 * Silence after which a running worker reads as hung rather than thinking.
 *
 * Grok sits 60–120s between tool cycles, so a 2-minute bar painted healthy
 * gaps as stalled rows and drove dig/cascade thrash. Matches the
 * 5-minute sub-agent stall nudge so UI and salvage agree on "quiet too long".
 */
export const DEFAULT_STALL_MS = 300_000;

/**
 * How long one tool call may stay outstanding before the lane reads stalled.
 *
 * Without it `in_tool` would be terminal: a wedged build or a shell blocked
 * on stdin reads busy forever. Generous on purpose — real test suites and
 * builds run for minutes. Also backstops calls that never report a result:
 * the approval-suspend path emits no completion, so a call stays outstanding
 * forever.
 */
export const IN_TOOL_STALL_MS = 600_000;

/** "m:ss" — compact enough for a row's dim trailer. */
export function clockLabel(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** The single definition of what a lane is doing; every other surface reads
 * this result rather than comparing timestamps itself. */
export function laneState(
  session: AgentProgressSession,
  nowMs: number,
  stallMs: number = DEFAULT_STALL_MS,
  inToolStallMs: number = IN_TOOL_STALL_MS,
): LaneState {
  // Waiting on the director is work, not silence — never trip the
  // in-tool stall.
  if (session.currentToolName === "ask_director") return "in_tool";
  if (
    session.lifecycleStatus === "pending_init" &&
    session.runInFlight === false
  ) {
    return "queued";
  }
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

/** Live on the agents strip: TUI status is "running" and the lifecycle is
 * not interrupted. Missing lifecycleStatus stays live; interrupted leftovers
 * with in-flight tools are not live lanes. */
export function agentLaneIsLive(session: {
  readonly status: AgentProgressSession["status"];
  readonly lifecycleStatus?:
    | AgentProgressSession["lifecycleStatus"]
    | undefined;
}): boolean {
  return (
    session.status === "running" && session.lifecycleStatus !== "interrupted"
  );
}

/**
 * Progress for a running session's pending row, or null once it has finished
 * (a terminal session resolves its row through the tool-result path instead).
 *
 * The number explains the state: lifetime for a healthy lane, tool runtime
 * for one in a tool, silence length for a quiet one.
 */
export function agentProgress(
  session: AgentProgressSession,
  nowMs: number,
  stallMs: number = DEFAULT_STALL_MS,
): AgentProgress | null {
  if (session.status !== "running") return null;
  if (
    session.lifecycleStatus === "pending_init" &&
    session.runInFlight === false
  ) {
    return {
      stat: "queued",
      state: "queued",
      working: false,
      stalled: false,
    };
  }
  const elapsed = clockLabel(nowMs - session.startedAt);
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
      hasSubject && session.currentToolName !== null
        ? ` · ${subject} still running`
        : "";
    return {
      stat: `interrupted${toolBit}`,
      state,
      working: false,
      stalled: false,
    };
  }

  const liveSubject =
    tool === "ask_director" ? "ask_director · waiting on director" : subject;
  const hasLiveSubject = liveSubject !== null;
  const base = hasLiveSubject ? `${elapsed} · ${liveSubject}` : elapsed;
  // Operator chrome never renders "quiet"; state still carries stalled for
  // recovery consumers.
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
 * Fleet roll-up of the per-lane states.
 *
 * Without it the top-level indicator reports the parent's own activity —
 * mostly awaiting children — so it reads "working" while every lane is
 * stuck.
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
    if (!agentLaneIsLive(session)) continue;
    switch (laneState(session, nowMs, stallMs)) {
      case "queued":
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

/** Compact fleet summary for the status ticker; null with no live lanes so
 * the indicator behaves as in a plain single-agent turn. */
export function fleetLabel(fleet: FleetProgress): string | null {
  if (fleet.running === 0) return null;
  // Count only — never "stalled" / "quiet" for the operator.
  const parts = [`${fleet.running} agents`];
  if (fleet.stalled === 0 && fleet.inTool === fleet.running) {
    parts.push("in tools");
  }
  return parts.join(" · ");
}
