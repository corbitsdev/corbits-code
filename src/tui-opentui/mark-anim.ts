/**
 * The animated Corbits dither mark, ported from the web boot screen.
 *
 * Two passes composite per frame, exactly as the canvas version does:
 *
 * 1. A *color field* — an ordered Bayer dither of a travelling sine wave into
 *    two tones. The dither is what makes the mark shimmer; a terminal has the
 *    same texture natively, so it ports rather than being approximated.
 * 2. A *shape mask* — the real mark silhouette (`mark-shape.ts`), revealed
 *    left to right by `drawProg` and filled bottom-up by `fillProg`.
 *
 * Everything here is pure and clock-injected: `nowMs` is the only time source,
 * so the caller's existing 250 ms status tick drives the animation and tests
 * drive it deterministically. There is no timer in this module.
 */

import { MARK_COLS, MARK_COVERAGE, MARK_ROWS } from "./mark-shape.js"
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

/** Standard 4x4 ordered dither matrix. */
const BAYER4: readonly (readonly number[])[] = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
]

/** Where the wave sits when motion is suppressed. */
const STILL_WAVE = 0.6

/** Travelling sine field sampled at a cell, in [0, 1]. */
export function markWave(
  col: number,
  row: number,
  seconds: number,
  still: boolean,
): number {
  if (still) return STILL_WAVE
  const u = col / MARK_COLS
  const v = row / MARK_ROWS
  return 0.5 + 0.5 * Math.sin((u + v) * 5.0 - seconds * 1.6)
}

/**
 * Binary two-tone dither of the wave. The threshold comes from the cell's slot
 * in the Bayer matrix, so neighbouring cells flip at different wave values and
 * the gradient reads as texture instead of a band.
 */
export function ditherTone(
  col: number,
  row: number,
  seconds: number,
  still: boolean,
): string {
  const threshold = ((BAYER4[row & 3]?.[col & 3] ?? 0) + 0.5) / 16
  return markWave(col, row, seconds, still) > threshold ? UI.action : UI.actionDim
}

/** Sparsest to densest. Index 0 is an empty cell. */
const RAMP = [" ", "░", "▒", "▓", "█"] as const

/** Eighth blocks for the fill's leading edge, growing upward from the floor. */
const EIGHTHS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const

/**
 * Coverage is raised to this power before it picks a ramp glyph. The mark is a
 * thin ridgeline, so at five rows most cells are partially covered; the gamma
 * lifts them far enough up the ramp for the silhouette to read.
 */
const DENSITY_GAMMA = 0.6

export type MarkCell = {
  readonly char: string
  readonly fg: string
}

export type MarkInput = {
  readonly nowMs: number
  /** Hold the mark still: idle session, or reduced motion. */
  readonly still: boolean
}

/**
 * Composite one frame into a row-major cell grid.
 *
 * `alpha` has no terminal equivalent, so it scales density instead: the mark
 * thins out through the ramp toward empty rather than blending to black.
 */
export function renderMark(input: MarkInput): readonly (readonly MarkCell[])[] {
  const seconds = input.nowMs / 1000
  const { drawProg, fillProg, alpha } = markFrame(seconds, input.still)
  const revealed = drawProg * MARK_COLS
  const fillLine = MARK_ROWS * (1 - fillProg)

  const grid: MarkCell[][] = []
  for (let row = 0; row < MARK_ROWS; row++) {
    const cells: MarkCell[] = []
    // 1 once the row is wholly below the fill line, 0 once wholly above it.
    const rowFill = clamp01(row + 1 - fillLine)
    for (let col = 0; col < MARK_COLS; col++) {
      const coverage = MARK_COVERAGE[row]?.[col] ?? 0
      const fg = ditherTone(col, row, seconds, input.still)
      const reveal = clamp01(revealed - col)
      if (coverage === 0 || reveal === 0) {
        cells.push({ char: RAMP[0], fg })
        continue
      }
      const outline = coverage ** DENSITY_GAMMA
      // Filling lifts every silhouette cell toward solid, weighted by coverage
      // so the edge of the mark stays soft instead of squaring off.
      const fill = rowFill * (0.5 + 0.5 * coverage)
      const density = clamp01(Math.max(outline, fill) * reveal * alpha)
      cells.push({ char: fillEdgeChar(rowFill, fill, outline) ?? rampChar(density), fg })
    }
    grid.push(cells)
  }
  return grid
}

/**
 * The row the fill is currently crossing, drawn with eighth blocks so the
 * bottom-up sweep reads as continuous motion across only five rows.
 */
function fillEdgeChar(
  rowFill: number,
  fill: number,
  outline: number,
): string | null {
  if (rowFill <= 0 || rowFill >= 1 || fill <= outline) return null
  return EIGHTHS[Math.min(EIGHTHS.length - 1, Math.round(rowFill * 8) - 1)] ?? null
}

function rampChar(density: number): string {
  const index = Math.min(RAMP.length - 1, Math.round(density * (RAMP.length - 1)))
  return RAMP[index] ?? RAMP[0]
}

/** Flatten a frame to plain text — the shape assertion tests read this. */
export function markText(grid: readonly (readonly MarkCell[])[]): string {
  return grid.map((row) => row.map((cell) => cell.char).join("")).join("\n")
}
