/**
 * Live progress for a dispatched sub-agent's pending row in the transcript.
 *
 * A "task" tool call renders as one row for its whole lifetime (see
 * `runtime-bridge.ts`'s `syncAgentProgress`). While the call is outstanding
 * this fills in what a bare pending mark cannot say: how long the worker has
 * been running, what it is doing right now, and whether it has gone quiet
 * long enough to look hung rather than merely slow.
 */

/** Minimal session shape this module reads — avoids a hard dep on the store. */
export type AgentProgressSession = {
  readonly status: "running" | "done" | "failed" | "cancelled";
  readonly currentToolName: string | null;
  readonly startedAt: number;
  readonly lastActivityAt: number;
};

export type AgentProgress = {
  /** Dim trailer painted after the row's subject, e.g. "0:42 · grep". */
  readonly stat: string;
  /** True while the worker has reported activity within the stall window. */
  readonly working: boolean;
  /** True once silence has run longer than the stall window. */
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
 * Progress for a running session's pending row, or null once it has finished —
 * a terminal session resolves its row through the tool-result path instead.
 */
export function agentProgress(
  session: AgentProgressSession,
  nowMs: number,
  stallMs: number = DEFAULT_STALL_MS,
): AgentProgress | null {
  if (session.status !== "running") return null;
  const elapsed = clockLabel(nowMs - session.startedAt);
  const tool = session.currentToolName;
  const stalled = nowMs - session.lastActivityAt >= stallMs;
  return {
    stat: tool !== null && tool.length > 0 ? `${elapsed} · ${tool}` : elapsed,
    working: !stalled,
    stalled,
  };
}
