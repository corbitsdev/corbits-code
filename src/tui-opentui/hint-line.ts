/**
 * Bottom hint line composition.
 *
 * The shell has no permanent header or status bar: this single dim row is the
 * only always-on chrome besides the prompt box. It shows the keys that work in
 * the current state, plus state segments that appear only when they are not at
 * their default (empty queue, following tail, no interrupt latch).
 *
 * Pure: no renderer access, so the wording is testable without a frame.
 */

const SEP = "    "

/** Which surface owns the keyboard right now. */
export type HintSurface =
  | { readonly kind: "prompt" }
  | { readonly kind: "transcript" }
  | { readonly kind: "observe" }
  | { readonly kind: "overlay"; readonly filterable: boolean }

export type HintState = {
  readonly surface: HintSurface
  readonly run: "idle" | "busy"
  /** Subagents are live — Alt+A is worth advertising. */
  readonly workers: boolean
  readonly queue: number
  readonly interrupt: boolean
  /** Transcript scrolled off the tail (non-default follow state). */
  readonly pinned: boolean
  /** Live turn phase ("Working…") or null when idle. */
  readonly phase: string | null
  /** Transient feedback (copy result, attach failure). */
  readonly flash: string | null
  readonly attachments: number
}

function keySegments(state: HintState): readonly string[] {
  const surface = state.surface
  if (surface.kind === "overlay") {
    return surface.filterable
      ? ["↑↓ move", "type filter", "enter accept", "esc close"]
      : ["↑↓ move", "enter accept", "esc close"]
  }
  if (surface.kind === "observe") return ["esc back", "^C stop"]
  if (surface.kind === "transcript") {
    return ["↑↓ scroll", "tab prompt", "alt+c copy"]
  }

  const keys = ["enter send"]
  if (state.workers) keys.push("alt+a workers")
  keys.push("/ commands")
  keys.push(state.run === "busy" ? "^C stop" : "@ files")
  return keys
}

function stateSegments(state: HintState): readonly string[] {
  const segments: string[] = []
  const phase = normalizePhase(state.phase)
  if (phase !== null) segments.push(phase)
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
  return segments
}

function normalizePhase(phase: string | null): string | null {
  if (phase === null) return null
  const trimmed = phase.trim().replace(/[….]+$/u, "")
  return trimmed.length === 0 ? null : trimmed.toLowerCase()
}

/** Compose the single bottom hint row for the current shell state. */
export function composeHintLine(state: HintState): string {
  return [...keySegments(state), ...stateSegments(state)].join(SEP)
}
