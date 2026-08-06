/**
 * The Corbits mark, rasterized once into terminal cell grids.
 *
 * The brand mark is an SVG path (viewBox 32 115 437 270). Parsing and
 * scan-converting it at runtime would cost startup time to reproduce a value
 * that can never change, so the coverage grids are baked in here: each entry is
 * the fraction of the cell covered by the filled path, sampled 6x6 per cell
 * with the same centered 92% fit the web boot screen uses
 * (`computeMapTransform`).
 *
 * Cells are assumed twice as tall as they are wide, so a grid of W x H cells is
 * fitted into W x 2H square units and the mark's 1.62 aspect ratio survives.
 *
 * Three grids are baked, because one size cannot serve every job. The landing
 * picks the largest that fits its zone; below the largest, the ridgeline's
 * crossings start to collapse into each other and the silhouette drifts from
 * mark toward noise, so the smaller grids are fallbacks, not preferences.
 *
 *   `MARK_LARGE`  40x12 — the landing hero.
 *   `MARK_MID`    30x9  — a tall-enough terminal that still cannot seat 12 rows.
 *   `MARK_SMALL`  16x5  — the compact fallback, and the source the bottom-left
 *                 lockup downsamples into its one-row ridgeline.
 */

export type MarkGrid = {
  readonly cols: number
  readonly rows: number
  /** Row-major cell coverage in [0, 1]. `coverage[row][col]`. */
  readonly coverage: readonly (readonly number[])[]
}

export const MARK_SMALL: MarkGrid = {
  cols: 16,
  rows: 5,
  coverage: [
    [0, 0, 0, 0, 0, 0, 0, 0, 0.08, 0.44, 0.58, 0.11, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0.28, 0.31, 0.08, 0.67, 0.94, 0.67, 0.03, 0, 0],
    [0, 0, 0, 0.25, 0.56, 0.44, 0.39, 0.11, 0, 0.03, 0.67, 0.28, 0.25, 0.72, 0.06, 0],
    [0, 0.14, 0.36, 0.11, 0.31, 0.5, 0, 0, 0.25, 0.53, 0.19, 0, 0, 0.39, 0.53, 0],
    [0.08, 0.22, 0, 0, 0, 0, 0, 0.31, 0.31, 0, 0, 0, 0, 0, 0.28, 0.17],
  ],
}

export const MARK_MID: MarkGrid = {
  cols: 30,
  rows: 9,
  coverage: [
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.25, 0.61, 0.36, 0.03, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.08, 0.58, 0.42, 0.81, 1, 0.86, 0.33, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.28, 0.61, 0.08, 0, 0.22, 0.64, 1, 1, 0.86, 0.47, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.31, 0.5, 0.53, 0, 0, 0, 0, 0.44, 1, 0.75, 0.47, 0.94, 0.44, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0.06, 0.47, 0.81, 0.83, 0.33, 0.44, 0.42, 0, 0, 0, 0, 0, 0.03, 0.78, 0.86, 0.03, 0, 0.33, 0.97, 0.61, 0.03, 0, 0, 0],
    [0, 0, 0, 0, 0, 0.39, 0.67, 0.11, 0.17, 1, 0.97, 0.39, 0, 0, 0, 0, 0, 0.08, 0.75, 0.72, 0.08, 0, 0, 0, 0.31, 1, 0.22, 0, 0, 0],
    [0, 0, 0, 0.28, 0.58, 0.31, 0, 0, 0.08, 0.92, 0.28, 0, 0, 0, 0, 0.06, 0.5, 0.83, 0.33, 0, 0, 0, 0, 0, 0.06, 0.64, 0.81, 0.47, 0, 0],
    [0, 0, 0.44, 0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.22, 0.89, 0.47, 0.03, 0, 0, 0, 0, 0, 0, 0, 0, 0.28, 0.97, 0.06, 0],
    [0, 0.17, 0.19, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.33, 0.47, 0.08, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.36, 0.19, 0],
  ],
}

export const MARK_LARGE: MarkGrid = {
  cols: 40,
  rows: 12,
  coverage: [
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.11, 0.44, 0.36, 0.03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.03, 0.47, 0.72, 0.75, 1, 0.89, 0.42, 0.03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.28, 0.78, 0.39, 0, 0.81, 1, 1, 1, 0.86, 0.33, 0.03, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.53, 0.72, 0.08, 0, 0, 0.03, 0.28, 0.83, 1, 1, 1, 0.97, 0.58, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.06, 0.33, 0.67, 0.58, 0.03, 0, 0, 0, 0, 0, 0.89, 1, 0.97, 0.56, 0.83, 1, 0.36, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.25, 0.64, 0.53, 0.11, 0, 0.17, 0.81, 0.28, 0.19, 0, 0, 0, 0, 0, 0, 0.11, 1, 1, 0.28, 0, 0.06, 0.89, 1, 0.64, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0.22, 0.69, 0.5, 0.69, 1, 0.97, 0.61, 0.83, 0.17, 0, 0, 0, 0, 0, 0, 0, 0.06, 0.72, 1, 0.47, 0, 0, 0, 0.06, 0.67, 1, 0.78, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0.11, 0.64, 0.72, 0.11, 0, 0.19, 1, 1, 0.83, 0.14, 0, 0, 0, 0, 0, 0, 0, 0.19, 0.83, 0.92, 0.31, 0, 0, 0, 0, 0, 0, 0.97, 1, 0.03, 0, 0, 0, 0],
    [0, 0, 0, 0, 0.06, 0.5, 0.72, 0.33, 0, 0, 0, 0.03, 1, 0.78, 0.08, 0, 0, 0, 0, 0, 0, 0.11, 0.58, 0.94, 0.56, 0.06, 0, 0, 0, 0, 0, 0, 0, 0.61, 0.89, 0.81, 0.47, 0, 0, 0],
    [0, 0, 0, 0.17, 0.81, 0.31, 0, 0, 0, 0, 0, 0.14, 0.28, 0.03, 0, 0, 0, 0, 0, 0, 0.5, 0.97, 0.69, 0.14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.67, 1, 0.17, 0, 0],
    [0, 0, 0.33, 0.69, 0.14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.17, 0.69, 0.83, 0.28, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.11, 0.97, 0.56, 0, 0],
    [0, 0, 0.31, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.17, 0.5, 0.22, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.08, 0.31, 0, 0],
  ],
}

/** The compact grid's dimensions and coverage, the lockup's source of truth. */
export const MARK_COLS = MARK_SMALL.cols
export const MARK_ROWS = MARK_SMALL.rows
export const MARK_COVERAGE = MARK_SMALL.coverage
