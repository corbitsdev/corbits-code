/**
 * The persistent bottom-left brand lockup: a one-row mountain glyph followed by
 * the "corbits code" wordmark.
 *
 * It rides the prompt box's bottom border, at the left end, opposite the
 * working directory and branch. There is no status row left to share — the
 * permanent hint strip is gone — and a row is the scarcest thing in a
 * terminal, so the mark buys one of zero. Sitting in the border also means it
 * inherits the box's gutter and its narrow-terminal behaviour for free, and
 * when the rule cannot seat both labels the lockup is what goes: the workspace
 * is information, the mark is not.
 *
 * Motion reuses the landing mark's timeline (`markFrame`, `ditherTone`) so both
 * marks breathe together, and like it this module is pure and clock-injected:
 * `nowMs` in, cells out, no timer.
 */

import { ditherTone, markFrame, type MarkCell } from "./mark-anim.js"
import { MARK_COLS, MARK_COVERAGE, MARK_ROWS } from "./mark-shape.js"
import { UI } from "./theme.js"

/** Columns the miniature ridgeline occupies. */
export const LOCKUP_MARK_COLS = 5

export const LOCKUP_WORDMARK = "corbits code"

/** One space between the glyph and the wordmark. */
const GLYPH_GAP = " "

/** Total columns the lockup paints, wordmark included. */
export const LOCKUP_WIDTH =
  LOCKUP_MARK_COLS + GLYPH_GAP.length + LOCKUP_WORDMARK.length

/** Eighth blocks, shortest to tallest — the ridgeline's vertical resolution. */
const EIGHTHS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const

/**
 * Collapse the baked mark into one row of ridge heights in [0, 1].
 *
 * Each of the full mark's columns contributes the height of its highest
 * covered cell; those columns are then bucketed into `LOCKUP_MARK_COLS` and
 * reduced by max, so the summit survives the downsample instead of being
 * averaged away into a flat bar.
 */
function ridgeHeights(): readonly number[] {
  const perColumn: number[] = []
  for (let col = 0; col < MARK_COLS; col++) {
    let top = MARK_ROWS
    for (let row = 0; row < MARK_ROWS; row++) {
      if ((MARK_COVERAGE[row]?.[col] ?? 0) > 0) {
        top = row
        break
      }
    }
    perColumn.push(top === MARK_ROWS ? 0 : (MARK_ROWS - top) / MARK_ROWS)
  }
  const bucket = MARK_COLS / LOCKUP_MARK_COLS
  const heights: number[] = []
  for (let slot = 0; slot < LOCKUP_MARK_COLS; slot++) {
    const from = Math.floor(slot * bucket)
    const to = Math.min(MARK_COLS, Math.floor((slot + 1) * bucket))
    let peak = 0
    for (let col = from; col < to; col++) {
      peak = Math.max(peak, perColumn[col] ?? 0)
    }
    heights.push(peak)
  }
  return heights
}

const RIDGE = ridgeHeights()

export type LockupInput = {
  readonly nowMs: number
  /** Hold the settled frame: idle session, or reduced motion. */
  readonly still: boolean
}

/**
 * The lockup as coloured cells, left to right. `still` is the settled state —
 * the whole ridgeline at full height in the mark's steady tone.
 */
export function lockupCells(input: LockupInput): readonly MarkCell[] {
  const seconds = input.nowMs / 1000
  const { drawProg, fillProg, alpha } = markFrame(seconds, input.still)
  // One row has no vertical reveal to spend, so draw and fill both drive the
  // ridge's height and the fade lands on it too.
  const grow = input.still ? 1 : Math.min(1, drawProg * 0.5 + fillProg * 0.5)
  const cells: MarkCell[] = []
  for (let col = 0; col < LOCKUP_MARK_COLS; col++) {
    const height = (RIDGE[col] ?? 0) * grow * alpha
    cells.push({
      char: ridgeChar(height),
      fg: ditherTone(col, 0, seconds, input.still),
    })
  }
  for (const char of `${GLYPH_GAP}${LOCKUP_WORDMARK}`) {
    cells.push({ char, fg: UI.textDim })
  }
  return cells
}

function ridgeChar(height: number): string {
  if (height <= 0) return " "
  const index = Math.min(
    EIGHTHS.length - 1,
    Math.max(0, Math.round(height * EIGHTHS.length) - 1),
  )
  return EIGHTHS[index] ?? " "
}

/** Plain-text rendering of a lockup frame — what the shape tests read. */
export function lockupText(cells: readonly MarkCell[]): string {
  return cells.map((cell) => cell.char).join("")
}
