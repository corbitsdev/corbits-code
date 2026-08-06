/**
 * The bottom-left status slot: a token peak, then whatever the session is
 * currently doing.
 *
 * It rides the prompt box's bottom border, at the left end, opposite the
 * working directory and branch. There is no status row left to share — the
 * permanent hint strip is gone — and a row is the scarcest thing in a terminal,
 * so the slot buys one of zero. Sitting in the border also means it inherits
 * the box's gutter and its narrow-terminal behaviour for free, and when the
 * rule cannot seat both labels the slot is what goes: the workspace is
 * information, the mark is not.
 *
 * Idle it reads `▂█▃ corbits code`; while a turn runs it reads the live phase
 * — `thinking`, `responding`, the running tool's name. The motion is the slot
 * changing what it *says*, crossfading through the warm dim tones. An earlier
 * version animated a wide ridgeline instead; one row has too little vertical
 * range for a mountain to deform legibly, and widening it only flattened it
 * further. A few cells is a token, not a picture, so it needs no valley.
 *
 * Pure and clock-injected: `nowMs` in, cells out, no timer.
 */

import { type MarkCell } from "./mark-anim.js"
import { MARK_RIDGE } from "./mark-shape.js"
import { UI } from "./theme.js"

/** Eighth blocks, tallest last. Index 0 is an empty cell. */
const BLOCKS = " ▁▂▃▄▅▆▇█"

/** Columns the token peak occupies. */
export const LOCKUP_MARK_COLS = 3

export const LOCKUP_WORDMARK = "corbits code"

/** One space between the glyph and the text. */
const GLYPH_GAP = " "

/** How long a state change takes to cross the fade ramp. */
export const LOCKUP_FADE_MS = 240

/**
 * The mark reduced to three cells: a summit and the toe of each slope.
 *
 * The summit takes its bucket's peak — a token that loses its peak is not a
 * mountain — while the flanks take a lower quartile, so they read as ground
 * rising rather than as two more summits.
 */
function tokenGlyph(): string {
  const bucket = MARK_RIDGE.length / LOCKUP_MARK_COLS
  const cells: string[] = []
  for (let slot = 0; slot < LOCKUP_MARK_COLS; slot++) {
    const samples = MARK_RIDGE.slice(
      Math.floor(slot * bucket),
      Math.floor((slot + 1) * bucket),
    )
    const summit = slot === (LOCKUP_MARK_COLS - 1) / 2
    const sorted = [...samples].sort((a, b) => a - b)
    const height = summit
      ? Math.max(...samples)
      : (sorted[Math.floor(sorted.length / 4)] ?? 0)
    cells.push(BLOCKS[Math.min(8, Math.max(0, Math.round(height * 8)))] ?? " ")
  }
  return cells.join("")
}

export const LOCKUP_MARK = tokenGlyph()

/**
 * Fade ramps, faintest first. A terminal has no alpha, so a transition steps
 * through the warm dim tones toward its resting tone instead of blending.
 */
const MARK_FADE = [UI.textFaint, UI.actionDim, UI.action] as const
const WORDMARK_FADE = [UI.textFaint, UI.textDim] as const
const PHASE_FADE = [UI.textFaint, UI.textDim, UI.text] as const

export type LockupInput = {
  readonly nowMs: number
  /** Hold the settled frame: idle session, or reduced motion. */
  readonly still: boolean
  /** Live phase word, or null when the session is idle. */
  readonly phase?: string | null
  /** Clock reading when the slot's text last changed. */
  readonly changedMs?: number
}

/** What the slot says: the phase while a turn runs, the wordmark otherwise. */
export function lockupLabel(phase: string | null | undefined): string {
  const live = phase?.trim() ?? ""
  return live.length > 0 ? live : LOCKUP_WORDMARK
}

/** Columns the slot paints for a given state. */
export function lockupWidth(phase: string | null | undefined): number {
  return LOCKUP_MARK.length + GLYPH_GAP.length + lockupLabel(phase).length
}

/**
 * The slot as coloured cells, left to right. `still` is the settled state: the
 * idle wordmark at its resting tones, with nothing left to animate.
 */
export function lockupCells(input: LockupInput): readonly MarkCell[] {
  const live = (input.phase?.trim().length ?? 0) > 0
  const progress = fadeProgress(input)
  const cells: MarkCell[] = []
  for (const char of LOCKUP_MARK) {
    cells.push({ char, fg: toneAt(MARK_FADE, progress) })
  }
  const textTone = toneAt(live ? PHASE_FADE : WORDMARK_FADE, progress)
  for (const char of `${GLYPH_GAP}${lockupLabel(input.phase)}`) {
    cells.push({ char, fg: textTone })
  }
  return cells
}

/**
 * 0 the moment the text changes, 1 once the fade has run. A settled slot skips
 * it entirely: idle is genuinely still, and the monitor tick that would carry
 * the remaining frames has already stopped by then.
 */
function fadeProgress(input: LockupInput): number {
  if (input.still || input.changedMs === undefined) return 1
  const elapsed = input.nowMs - input.changedMs
  if (!Number.isFinite(elapsed) || elapsed >= LOCKUP_FADE_MS) return 1
  return elapsed <= 0 ? 0 : elapsed / LOCKUP_FADE_MS
}

function toneAt(ramp: readonly string[], progress: number): string {
  const index = Math.min(ramp.length - 1, Math.floor(progress * ramp.length))
  return ramp[Math.max(0, index)] ?? ramp[ramp.length - 1] ?? UI.textDim
}

/** Plain-text rendering of a lockup frame — what the shape tests read. */
export function lockupText(cells: readonly MarkCell[]): string {
  return cells.map((cell) => cell.char).join("")
}
