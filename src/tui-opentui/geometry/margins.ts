/**
 * Optical breathing room shared by every shell surface.
 *
 * The margin is one number for the whole interface — transcript, prompt box,
 * model bar, hint row and overlay host all sit inside it — so the shell reads
 * as a single column of content rather than panes that happen to be stacked.
 *
 * Horizontal only. The row budget is the geometry resolver's business; nothing
 * here can take a row away from it.
 */

/** Gutter columns on each side once the terminal can afford them. */
export const SIDE_MARGIN = 2

/** Half gutter for terminals too narrow to spend four columns on air. */
export const NARROW_SIDE_MARGIN = 1

/** At or above this width the full gutter is affordable. */
export const MARGIN_FULL_MIN_COLUMNS = 60

/** Below this width every column belongs to content: the gutter goes to zero. */
export const MARGIN_MIN_COLUMNS = 40

/** Gutter width for a terminal of `columns` columns. */
export function resolveSideMargin(columns: number): number {
  const cols = Math.max(0, Math.floor(columns))
  if (cols >= MARGIN_FULL_MIN_COLUMNS) return SIDE_MARGIN
  if (cols >= MARGIN_MIN_COLUMNS) return NARROW_SIDE_MARGIN
  return 0
}

/** Columns left for content after both gutters. */
export function resolveContentWidth(columns: number): number {
  const cols = Math.max(1, Math.floor(columns))
  return Math.max(1, cols - resolveSideMargin(cols) * 2)
}

/**
 * Blank rows above the first transcript row. Carved out of the transcript
 * residual by the shell, never out of chrome, so the resolved row budget holds.
 */
export const TOP_PAD_ROWS = 1

/** Below this many transcript rows the pad is not worth the row it costs. */
export const TOP_PAD_MIN_TRANSCRIPT_ROWS = 6

/** Top pad rows affordable for a transcript of `transcriptRows` rows. */
export function resolveTopPadRows(transcriptRows: number): number {
  return transcriptRows >= TOP_PAD_MIN_TRANSCRIPT_ROWS ? TOP_PAD_ROWS : 0
}

/**
 * Rows below the prompt box. Zero: the box sits on the terminal's last row.
 *
 * A blank row here reads as the interface floating rather than resting on the
 * bottom edge — the box is the thing the operator types into, and it wants to
 * be where the cursor already is. The side gutters still keep it off the left
 * and right edges, which is where crowding actually shows.
 */
export const BOTTOM_MARGIN_ROWS = 0

/**
 * Below this terminal height the margin is not worth the row it costs — the
 * same 24-row line the resolver already treats as "short terminal" for the
 * transcript floor, so every yield point in the layout agrees on where a
 * terminal stops being able to afford anything optional.
 */
export const BOTTOM_MARGIN_MIN_ROWS = 24

/** Bottom margin rows affordable for a terminal of `terminalRows` rows. */
export function resolveBottomMarginRows(terminalRows: number): number {
  return terminalRows >= BOTTOM_MARGIN_MIN_ROWS ? BOTTOM_MARGIN_ROWS : 0
}
