/**
 * The transient notice row.
 *
 * There is no permanent status strip: keys are discoverable from the landing
 * screen and the command palette, and the prompt box's border already carries
 * the model and the workspace. What is left is state that is only sometimes
 * true — a queued message, a copy result, pinned scroll, attachments —
 * and that gets a row only while it has something to say. When every segment
 * is at its default the row composes to the empty string and the shell hides
 * it, giving the row back to the transcript.
 *
 * MCP authorization is not a notice-row concern. A server waiting on auth is
 * a standing condition with a home on the prompt box (`mcp !` left of the
 * model label) and a surface in /mcp; it does not earn a transcript-adjacent
 * row of its own.
 *
 * A live turn contributes nothing here. The prompt border already carries the
 * running state — the bottom-left slot swaps the wordmark for the live phase,
 * and the meter beside it moves — so a ramp on this row was a second animation
 * saying the same thing, one row above the first.
 *
 * Pure: no renderer access, so the wording is testable without a frame.
 */

const SEP = "    "

export const STEER_WAIT_NOTICE_MS = 3_000

export type NoticeState = {
  /** Soft-steer pending (Enter mid-run → drain at tool.boundary). */
  readonly steer: number
  /** Follow-up pending (Alt+Enter mid-run → drain only when idle). */
  readonly followUp: number
  /**
   * Parent tool name to surface after `STEER_WAIT_NOTICE_MS`, or null.
   * Gated by `resolveWaitingOn`; this field only controls wording.
   */
  readonly waitingOn: string | null
  readonly interrupt: boolean
  /** Transcript scrolled off the tail (non-default follow state). */
  readonly pinned: boolean
  /** Transient feedback (copy result, attach failure, exit arming). */
  readonly flash: string | null
  readonly attachments: number
}

/**
 * Name the in-flight parent tool once a steer has been waiting long enough.
 * Silent below the delay, with no pending steer, or with no live parent tool.
 */
export function resolveWaitingOn(
  steer: number,
  inFlight: { name: string; startedAt: number } | null,
  nowMs: number,
): string | null {
  if (steer <= 0 || inFlight === null) return null
  if (nowMs - inFlight.startedAt < STEER_WAIT_NOTICE_MS) return null
  const name = inFlight.name.trim()
  return name.length > 0 ? name : null
}

export function composeNoticeLine(state: NoticeState): string {
  const segments: string[] = []
  if (state.steer > 0) segments.push(`steer ${state.steer}`)
  if (state.followUp > 0) segments.push(`follow-up ${state.followUp}`)
  if (state.waitingOn) segments.push(`waiting on ${state.waitingOn}`)
  if (state.pinned) segments.push("pinned")
  // "interrupt" is not a standing notice. Mid-run stop feedback is a system
  // row (wording without "interrupt"); empty-prompt Ctrl+C arms exit via flash.
  if (state.attachments > 0) {
    segments.push(
      `${state.attachments} image${state.attachments === 1 ? "" : "s"}`,
    )
  }
  const flash = state.flash?.trim() ?? ""
  if (flash.length > 0) segments.push(flash)
  return segments.join(SEP)
}
