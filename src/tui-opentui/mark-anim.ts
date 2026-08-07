/**
 * The animated Corbits mark, ported from the web boot screen.
 *
 * The mark is the real silhouette (`mark-shape.ts`) drawn as a solid body,
 * revealed left to right by `drawProg` and filled bottom-up by `fillProg`. The
 * canvas version shades it with an ordered Bayer dither of a travelling sine
 * wave; at hero size a terminal renders that as visible noise rather than as
 * shimmer, so the terminal mark is opaque instead.
 *
 * Everything here is pure and clock-injected: `nowMs` is the only time source,
 * so the caller's existing 250 ms status tick drives the animation and tests
 * drive it deterministically. There is no timer in this module.
 */

import { MARK_SMALL, type MarkGrid } from "./mark-shape.js"
import { UI } from "./theme.js"

/** One full loop of the draw/fill/fade timeline. */
export const MARK_PERIOD_SECONDS = 4.6

/** Smoothstep easing, clamped to [0, 1]. */
export function smooth(x: number): number {
  const c = clamp01(x)
  return c * c * (3 - 2 * c)
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

export type MarkFrame = {
  /** 0..1 how much of the silhouette is revealed, left to right. */
  readonly drawProg: number
  /** 0..1 bottom-up fill of the silhouette. */
  readonly fillProg: number
  /** 0..1 overall opacity; the terminal approximates it as density. */
  readonly alpha: number
}

/**
 * The looping timeline: draw in (0-38%), hold (38-48%), fill bottom-up
 * (48-76%), hold full (76-90%), fade out (90-100%), then repeat. `still`
 * (reduced motion, or an idle session) is a static, fully-filled mark.
 */
export function markFrame(seconds: number, still: boolean): MarkFrame {
  if (still) return { drawProg: 1, fillProg: 1, alpha: 1 }
  const wrapped =
    ((seconds % MARK_PERIOD_SECONDS) + MARK_PERIOD_SECONDS) % MARK_PERIOD_SECONDS
  const p = wrapped / MARK_PERIOD_SECONDS
  if (p < 0.38) return { drawProg: smooth(p / 0.38), fillProg: 0, alpha: 1 }
  if (p < 0.48) return { drawProg: 1, fillProg: 0, alpha: 1 }
  if (p < 0.76) {
    return { drawProg: 1, fillProg: smooth((p - 0.48) / 0.28), alpha: 1 }
  }
  if (p < 0.9) return { drawProg: 1, fillProg: 1, alpha: 1 }
  return { drawProg: 1, fillProg: 1, alpha: smooth((1 - p) / 0.1) }
}

/** Eighth blocks, shortest to tallest, growing upward from the cell floor. */
const EIGHTHS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const

/**
 * Coverage is raised to this power once a cell is filled. The mark is a thin
 * ridgeline, so most cells it touches are only partially covered; the gamma
 * lifts them far enough for the silhouette to read as one solid body while
 * leaving the sparsest edge cells short enough to still slope.
 */
const FILL_GAMMA = 0.6

export type MarkCell = {
  readonly char: string
  readonly fg: string
}

export type MarkInput = {
  readonly nowMs: number
  /** Hold the mark still: idle session, or reduced motion. */
  readonly still: boolean
  /** Which baked rasterization to composite. Defaults to the compact grid. */
  readonly grid?: MarkGrid
}

/**
 * Composite one frame into a row-major cell grid.
 *
 * The silhouette is drawn solid: a wholly covered cell is `█` and a partly
 * covered one is the eighth block matching its coverage, so the ridgeline
 * slopes instead of staircasing. No dither texture survives inside the shape —
 * the mark is a mountain, and a mountain is opaque.
 *
 * `alpha` has no terminal equivalent, so it scales the block height instead:
 * the mark sinks toward empty rather than blending to black.
 */
export function renderMark(input: MarkInput): readonly (readonly MarkCell[])[] {
  const shape = input.grid ?? MARK_SMALL
  const seconds = input.nowMs / 1000
  const { drawProg, fillProg, alpha } = markFrame(seconds, input.still)
  const revealed = drawProg * shape.cols
  const fillLine = shape.rows * (1 - fillProg)

  const grid: MarkCell[][] = []
  for (let row = 0; row < shape.rows; row++) {
    const cells: MarkCell[] = []
    // 1 once the row is wholly below the fill line, 0 once wholly above it.
    const rowFill = clamp01(row + 1 - fillLine)
    for (let col = 0; col < shape.cols; col++) {
      const coverage = shape.coverage[row]?.[col] ?? 0
      const reveal = clamp01(revealed - col)
      if (coverage === 0 || reveal === 0) {
        cells.push({ char: " ", fg: UI.action })
        continue
      }
      // The outline states the shape at its true coverage; filling lifts it
      // toward solid without squaring off the edge cells that carry the slope.
      const outline = coverage
      const filled = coverage ** FILL_GAMMA
      const height = clamp01(
        (outline + (filled - outline) * rowFill) * reveal * alpha,
      )
      cells.push({
        char: fillEdgeChar(rowFill, height) ?? blockChar(height),
        fg: UI.action,
      })
    }
    grid.push(cells)
  }
  return grid
}

/**
 * The row the fill is currently crossing. Solid interior cells change too
 * little between outline and filled to show the sweep on their own, so the
 * crossing row is drawn at the fill's own height — capped by the cell, which
 * keeps the wipe inside the silhouette.
 */
function fillEdgeChar(rowFill: number, height: number): string | null {
  if (rowFill <= 0 || rowFill >= 1) return null
  return blockChar(Math.min(rowFill, height))
}

function blockChar(height: number): string {
  const index = Math.min(
    EIGHTHS.length - 1,
    Math.round(height * EIGHTHS.length) - 1,
  )
  // Below half an eighth there is no block short enough to be honest: the cell
  // is closer to empty, which is also how the fade reaches nothing.
  return index < 0 ? " " : (EIGHTHS[index] ?? " ")
}

/** Flatten a frame to plain text — the shape assertion tests read this. */
export function markText(grid: readonly (readonly MarkCell[])[]): string {
  return grid.map((row) => row.map((cell) => cell.char).join("")).join("\n")
}
