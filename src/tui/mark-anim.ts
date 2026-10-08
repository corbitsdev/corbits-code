/**
 * The animated Corbits mark, ported from the web boot screen.
 *
 * The silhouette (`mark-shape.ts`) draws solid, revealed left to right by
 * `drawProg` and filled bottom-up by `fillProg`. The web build dithers; at
 * hero size a terminal renders dithering as noise, so the terminal mark is
 * opaque.
 *
 * Pixel snow falls over sky cells on the same injected clock. `still` freezes
 * the mountain's timeline on its full frame but leaves snow drifting — an
 * idle landing must stay alive — while `reducedMotion` is the separate snow
 * gate. Mountain cells always win over flakes.
 *
 * Pure and clock-injected: `nowMs` is the only time source.
 */

import { MARK_SMALL, type MarkGrid } from "./mark-shape.js";
import { UI } from "./theme.js";

/** One full loop of the draw/fill/fade timeline. */
export const MARK_PERIOD_SECONDS = 4.6;

/** Smoothstep easing, clamped to [0, 1]. */
export function smooth(x: number): number {
  const c = clamp01(x);
  return c * c * (3 - 2 * c);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export interface MarkFrame {
  /** 0..1 how much of the silhouette is revealed, left to right. */
  readonly drawProg: number;
  /** 0..1 bottom-up fill of the silhouette. */
  readonly fillProg: number;
  /** 0..1 overall opacity; the terminal approximates it as density. */
  readonly alpha: number;
}

/**
 * The looping timeline: draw in (0-38%), hold (38-48%), fill bottom-up
 * (48-76%), hold full (76-90%), fade out (90-100%), repeat. `still` freezes
 * it on a fully-filled mark (idle landing); reduced motion is a separate
 * snow gate.
 */
export function markFrame(seconds: number, still: boolean): MarkFrame {
  if (still) return { drawProg: 1, fillProg: 1, alpha: 1 };
  const wrapped =
    ((seconds % MARK_PERIOD_SECONDS) + MARK_PERIOD_SECONDS) %
    MARK_PERIOD_SECONDS;
  const p = wrapped / MARK_PERIOD_SECONDS;
  if (p < 0.38) return { drawProg: smooth(p / 0.38), fillProg: 0, alpha: 1 };
  if (p < 0.48) return { drawProg: 1, fillProg: 0, alpha: 1 };
  if (p < 0.76) {
    return { drawProg: 1, fillProg: smooth((p - 0.48) / 0.28), alpha: 1 };
  }
  if (p < 0.9) return { drawProg: 1, fillProg: 1, alpha: 1 };
  return { drawProg: 1, fillProg: 1, alpha: smooth((1 - p) / 0.1) };
}

/** Eighth blocks, shortest to tallest, growing upward from the cell floor. */
const EIGHTHS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/**
 * Exponent applied to filled coverage. The mark is a thin ridgeline, so
 * most cells it touches are only partly covered; the gamma lifts them far
 * enough to read as one solid body while the sparsest edge cells stay short
 * enough to keep the slope.
 */
const FILL_GAMMA = 0.6;

/** Snowflake pixel; exported so tests can tell sky from mountain. */
export const SNOW_CHAR = "·";

/** Fraction of columns that host a flake; low so the sky stays sparse. */
const SNOW_COLUMN_FRACTION = 0.18;

/** Rows-per-second fall rate; slow enough to feel like drift. */
const SNOW_FALL_SPEED = 0.55;

export interface MarkCell {
  readonly char: string;
  readonly fg: string;
}

export interface MarkInput {
  readonly nowMs: number;
  /**
   * Freeze the mountain's timeline on its full frame (idle landing). Snow
   * is not gated by this — see `reducedMotion`.
   */
  readonly still: boolean;
  /** Suppresses snow regardless of `still`. Defaults to off. */
  readonly reducedMotion?: boolean;
  /** Baked rasterization to composite; defaults to the compact grid. */
  readonly grid?: MarkGrid;
}

/**
 * Stable unit hash in [0, 1) from integer seeds, so flake columns and
 * phases never jitter between frames.
 */
function unitHash(a: number, b = 0): number {
  const n = Math.imul(a + 1, 374761393) ^ Math.imul(b + 1, 668265263);
  const x = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((x >>> 0) % 10_000) / 10_000;
}

/**
 * Whether a sky cell holds a flake at `seconds`. Sparse columns only; each
 * active column carries one flake with a private phase and slight speed
 * variation, so the field does not march as a rigid lattice.
 */
function snowflakeAt(
  row: number,
  col: number,
  seconds: number,
  rows: number,
): boolean {
  if (rows <= 0) return false;
  if (unitHash(col, 1) > SNOW_COLUMN_FRACTION) return false;
  const phase = unitHash(col, 2) * rows;
  const speed = SNOW_FALL_SPEED * (0.75 + unitHash(col, 3) * 0.5);
  const wrapped = (((seconds * speed + phase) % rows) + rows) % rows;
  return Math.floor(wrapped) === row;
}

/**
 * Composite one frame into a row-major cell grid.
 *
 * The silhouette is drawn solid: a fully covered cell is `█`, a partly
 * covered one is the eighth block matching its coverage, so the ridgeline
 * slopes instead of staircasing.
 *
 * Sky cells (zero coverage) may hold one falling snow pixel; flakes never
 * overwrite mountain coverage. `reducedMotion` suppresses them, `still`
 * does not (see `snowOn` below).
 *
 * `alpha` has no terminal equivalent, so it scales the block height instead:
 * the mark sinks toward empty rather than blending to black.
 */
export function renderMark(input: MarkInput): readonly (readonly MarkCell[])[] {
  const shape = input.grid ?? MARK_SMALL;
  const seconds = input.nowMs / 1000;
  const { drawProg, fillProg, alpha } = markFrame(seconds, input.still);
  const revealed = drawProg * shape.cols;
  const fillLine = shape.rows * (1 - fillProg);
  // Not gated by `still`: the mountain can sit frozen while snow drifts
  // (idle landing). Fade-out drops the snow too, so it never outlasts the
  // mark it drifts over.
  const snowOn = alpha === 1 && !input.reducedMotion;

  const grid: MarkCell[][] = [];
  for (let row = 0; row < shape.rows; row++) {
    const cells: MarkCell[] = [];
    // 1 below the fill line, 0 above it.
    const rowFill = clamp01(row + 1 - fillLine);
    for (let col = 0; col < shape.cols; col++) {
      const coverage = shape.coverage[row]?.[col] ?? 0;
      const reveal = clamp01(revealed - col);
      if (coverage === 0 || reveal === 0) {
        // Snow only in true sky; unrevealed mountain cells stay empty so
        // the draw keeps a clean silhouette edge.
        if (
          snowOn &&
          coverage === 0 &&
          snowflakeAt(row, col, seconds, shape.rows)
        ) {
          cells.push({ char: SNOW_CHAR, fg: UI.textFaint });
        } else {
          cells.push({ char: " ", fg: UI.action });
        }
        continue;
      }
      // Filling lifts the outline toward solid without squaring the edge
      // cells that carry the slope.
      const outline = coverage;
      const filled = coverage ** FILL_GAMMA;
      const height = clamp01(
        (outline + (filled - outline) * rowFill) * reveal * alpha,
      );
      cells.push({
        char: fillEdgeChar(rowFill, height) ?? blockChar(height),
        fg: UI.action,
      });
    }
    grid.push(cells);
  }
  return grid;
}

/**
 * The row the fill is crossing. Interior cells change too little between
 * outline and filled to show the sweep, so the crossing row is drawn at the
 * fill's own height — capped by the cell to keep the wipe inside the
 * silhouette.
 */
function fillEdgeChar(rowFill: number, height: number): string | null {
  if (rowFill <= 0 || rowFill >= 1) return null;
  return blockChar(Math.min(rowFill, height));
}

function blockChar(height: number): string {
  const index = Math.min(
    EIGHTHS.length - 1,
    Math.round(height * EIGHTHS.length) - 1,
  );
  // Below half an eighth no block is short enough to be honest; the cell is
  // closer to empty, which is also how the fade reaches nothing.
  return index < 0 ? " " : (EIGHTHS[index] ?? " ");
}

/** Flatten a frame to plain text for the shape assertion tests. */
export function markText(grid: readonly (readonly MarkCell[])[]): string {
  return grid.map((row) => row.map((cell) => cell.char).join("")).join("\n");
}
