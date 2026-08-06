/**
 * The transient notice row.
 *
 * There is no permanent status strip: keys are discoverable from the landing
 * screen and the command palette, and the prompt box's border already carries
 * the model and the workspace. What is left is state that is only sometimes
 * true — a queued message, a latched interrupt, a copy result, a live turn —
 * and that gets a row only while it has something to say. When every segment
 * is at its default the row composes to the empty string and the shell hides
 * it, giving the row back to the transcript.
 *
 * The live turn contributes its density ramp and nothing else: the animated
 * lockup in the border already says work is running, so the word would be a
 * second copy of the same signal.
 *
 * Pure: no renderer access, so the wording is testable without a frame.
 */

const SEP = "    "

/** Density glyphs the ramp is drawn from (see ./ramp.ts). */
const RAMP_GLYPHS = /^[░▒▓█]+/u

export type NoticeState = {
  readonly queue: number
  readonly interrupt: boolean
  /** Transcript scrolled off the tail (non-default follow state). */
  readonly pinned: boolean
  /** Live turn line (`███▒░  working`) or null when idle. */
  readonly phase: string | null
  /** Transient feedback (copy result, attach failure, exit arming). */
  readonly flash: string | null
  readonly attachments: number
}

/** The ramp glyphs at the head of a turn line, without the phase word. */
export function rampPrefix(phase: string | null): string {
  if (phase === null) return ""
  return RAMP_GLYPHS.exec(phase.trim())?.[0] ?? ""
}

/**
 * Compose the transient row. An empty result means the row has nothing to say
 * and the shell drops it.
 */
export function composeNoticeLine(state: NoticeState): string {
  const segments: string[] = []
  const ramp = rampPrefix(state.phase)
  if (ramp.length > 0) segments.push(ramp)
  if (state.queue > 0) segments.push(`queue ${state.queue}`)
  if (state.pinned) segments.push("pinned")
  if (state.interrupt) segments.push("interrupt")
  if (state.attachments > 0) {
    segments.push(
      `${state.attachments} image${state.attachments === 1 ? "" : "s"}`,
    )
  }
  const flash = state.flash?.trim() ?? ""
  if (flash.length > 0) segments.push(flash)
  return segments.join(SEP)
}
