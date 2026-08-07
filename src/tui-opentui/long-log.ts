/**
 * Long-log window strategy — keep multi-thousand-line sessions interactive.
 * Pure slice math; shell paints only the window, not the full history.
 *
 * Budget (Wave 6 defaults; CL-5399 may refine):
 * - Painted window: last N rows (or pin around offset)
 * - Collapse threshold: when history exceeds this, older rows stay in the
 *   model but drop from the render tree until scrolled into the window
 */

import type { StreamRow } from "./stream.js"

/** Rows kept in the paint tree under normal follow-tail. */
export const LONG_LOG_WINDOW = 200

/**
 * When total rows exceed this, append/scroll paths must use windowSlice
 * (never re-paint the full history).
 */
export const LONG_LOG_COLLAPSE_THRESHOLD = 500

export type LongLogWindow = {
  /** Inclusive start index into the full row log. */
  readonly start: number
  /** Exclusive end index. */
  readonly end: number
  /** Slice of rows to paint. */
  readonly rows: readonly StreamRow[]
  /** True when older rows exist above the window. */
  readonly truncatedAbove: boolean
  /** True when newer rows exist below the window (pinned). */
  readonly truncatedBelow: boolean
  /** Full log length. */
  readonly total: number
}

export type WindowSliceOpts = {
  /** Max rows to include (default LONG_LOG_WINDOW). */
  readonly windowSize?: number
  /**
   * Pin the window so this index is visible (keep-active-visible style).
   * When omitted, follow the tail (last windowSize rows).
   */
  readonly pinIndex?: number
}

/**
 * Compute which rows to paint for a long log.
 * Follow-tail by default; pinIndex keeps a historical row in view.
 */
export function windowSlice(
  log: readonly StreamRow[],
  opts?: WindowSliceOpts,
): LongLogWindow {
  const total = log.length
  const windowSize = Math.max(1, Math.floor(opts?.windowSize ?? LONG_LOG_WINDOW))

  if (total === 0) {
    return {
      start: 0,
      end: 0,
      rows: [],
      truncatedAbove: false,
      truncatedBelow: false,
      total: 0,
    }
  }

  let end: number
  let start: number

  if (opts?.pinIndex !== undefined) {
    const pin = Math.max(0, Math.min(total - 1, Math.floor(opts.pinIndex)))
    // Center-ish: keep pin in window; prefer showing context after pin when possible.
    start = Math.max(0, pin - Math.floor(windowSize / 2))
    end = Math.min(total, start + windowSize)
    start = Math.max(0, end - windowSize)
  } else {
    // Follow tail
    end = total
    start = Math.max(0, total - windowSize)
  }

  return {
    start,
    end,
    rows: log.slice(start, end),
    truncatedAbove: start > 0,
    truncatedBelow: end < total,
    total,
  }
}

/** Whether the log is large enough that windowing is mandatory. */
export function mustWindow(totalRows: number): boolean {
  return totalRows > LONG_LOG_COLLAPSE_THRESHOLD
}

/**
 * Collapse marker line for the paint tree when truncatedAbove.
 * Pure string — shell styles it as system chrome.
 */
export function collapseMarker(above: number): string {
  const n = Math.max(0, Math.floor(above))
  if (n <= 0) return ""
  return `… ${n} earlier line${n === 1 ? "" : "s"} collapsed`
}
