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
 * A live turn contributes nothing here. The prompt border already carries the
 * running state — the bottom-left slot swaps the wordmark for the live phase,
 * and the meter beside it moves — so a ramp on this row was a second animation
 * saying the same thing, one row above the first.
 *
 * Pure: no renderer access, so the wording is testable without a frame.
 */

const SEP = "    "

export type NoticeState = {
  readonly queue: number
  readonly interrupt: boolean
  /** Transcript scrolled off the tail (non-default follow state). */
  readonly pinned: boolean
  /** Transient feedback (copy result, attach failure, exit arming). */
  readonly flash: string | null
  readonly attachments: number
  /** Names of MCP servers still unauthorized; their tools stay unavailable. */
  readonly mcpNeedsAuth: readonly string[]
}

/** How many server names the segment spells out before it counts instead. */
const MCP_NAMES_SHOWN = 2

/**
 * Name the unauthorized servers rather than counting them: a bare count sends
 * the operator to /mcp to find out which one it meant, and reads as a claim
 * about whichever server they see there first.
 */
function mcpAuthNames(names: readonly string[]): string {
  const sorted = [...names].sort()
  if (sorted.length <= MCP_NAMES_SHOWN) return `mcp ${sorted.join(", ")}`
  const shown = sorted.slice(0, MCP_NAMES_SHOWN).join(", ")
  return `mcp ${shown} +${sorted.length - MCP_NAMES_SHOWN}`
}

/**
 * Compose the transient row. An empty result means the row has nothing to say
 * and the shell drops it.
 */
export function composeNoticeLine(state: NoticeState): string {
  const segments: string[] = []
  if (state.queue > 0) segments.push(`queue ${state.queue}`)
  if (state.pinned) segments.push("pinned")
  if (state.interrupt) segments.push("interrupt")
  if (state.attachments > 0) {
    segments.push(
      `${state.attachments} image${state.attachments === 1 ? "" : "s"}`,
    )
  }
  if (state.mcpNeedsAuth.length > 0) {
    segments.push(`${mcpAuthNames(state.mcpNeedsAuth)} needs auth (/mcp)`)
  }
  const flash = state.flash?.trim() ?? ""
  if (flash.length > 0) segments.push(flash)
  return segments.join(SEP)
}
