/**
 * The Corbits mark, rasterized once into a terminal cell grid.
 *
 * The brand mark is an SVG path (viewBox 32 115 437 270). Parsing and
 * scan-converting it at runtime would cost startup time to reproduce a value
 * that can never change, so the coverage grid is baked in here: each entry is
 * the fraction of the cell covered by the filled path, sampled 6x6 per cell
 * with the same centered 92% fit the web boot screen uses
 * (`computeMapTransform`).
 *
 * Cells are assumed twice as tall as they are wide, so 16x5 cells reproduce the
 * mark's 1.62 aspect ratio without distortion — the smallest grid at which the
 * ridgeline still reads as the mark rather than as noise.
 */

export const MARK_COLS = 16
export const MARK_ROWS = 5

/** Row-major cell coverage in [0, 1]. `MARK_COVERAGE[row][col]`. */
export const MARK_COVERAGE: readonly (readonly number[])[] = [
  [0, 0, 0, 0, 0, 0, 0, 0, 0.08, 0.44, 0.58, 0.11, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0.28, 0.31, 0.08, 0.67, 0.94, 0.67, 0.03, 0, 0],
  [0, 0, 0, 0.25, 0.56, 0.44, 0.39, 0.11, 0, 0.03, 0.67, 0.28, 0.25, 0.72, 0.06, 0],
  [0, 0.14, 0.36, 0.11, 0.31, 0.5, 0, 0, 0.25, 0.53, 0.19, 0, 0, 0.39, 0.53, 0],
  [0.08, 0.22, 0, 0, 0, 0, 0, 0.31, 0.31, 0, 0, 0, 0, 0, 0.28, 0.17],
] as const
