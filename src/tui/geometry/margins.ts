/**
 * Optical breathing room shared by every shell surface.
 *
 * The side gutter is one number for the whole interface — transcript, prompt
 * box, model bar, hint row and overlay host all sit inside it — so the shell
 * reads as a single column of content rather than panes that happen to be
 * stacked. Top and bottom pads are carved out of the transcript residual by
 * the shell after the geometry resolver has assigned heights, so they never
 * change the resolver's row budget.
 */

/**
 * Gutter columns on each side once the terminal can afford them.
 *
 * One column at every width the gutter exists at all. A single column is
 * already enough to keep content off the frame edge, which is the whole job,
 * and a wider gutter only read as excess air on a wide pane. There is no
 * middle tier: a width that can spare a column gets one, and a width that
 * cannot gets none.
 */
export const SIDE_MARGIN = 1

/** Below this width every column belongs to content: the gutter goes to zero. */
export const MARGIN_MIN_COLUMNS = 40

/** Gutter width for a terminal of `columns` columns. */
export function resolveSideMargin(columns: number): number {
  const cols = Math.max(0, Math.floor(columns))
  return cols >= MARGIN_MIN_COLUMNS ? SIDE_MARGIN : 0
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
 * Rows below the prompt box once the terminal can afford them.
 *
 * One blank row keeps the prompt off the terminal's last line the same way
 * `TOP_PAD_ROWS` keeps the first transcript row off the top edge and
 * `SIDE_MARGIN` keeps content off the left and right. More than one only
 * reads as the interface floating, so there is no middle tier.
 */
export const BOTTOM_MARGIN_ROWS = 1

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
