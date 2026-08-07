/**
 * How tall the prompt box is for what is being composed.
 *
 * Three rules, in order of precedence:
 *
 * 1. The box never shrinks below its resting size — an empty prompt still
 *    offers PROMPT_IDLE_INPUT_ROWS lines, so there is somewhere to write and so
 *    the first typed line does not sit against the animated mark in the bottom
 *    rule.
 * 2. It grows a row per visual line of content, so a longer prompt is visible
 *    while it is being written rather than scrolling under itself immediately.
 * 3. It stops at PROMPT_CAP_FRACTION of the terminal. Past that the input
 *    scrolls internally (OpenTUI's editor view follows the caret), because rows
 *    spent here come straight out of the transcript.
 *
 * The resolver has the last word on a short terminal: it collapses the box back
 * toward PROMPT_BASE_ROWS when the transcript would otherwise breach its floor.
 * Reading the transcript matters more than seeing the whole draft at once.
 *
 * Pure: line counts in, rows out. The caller measures the wrapped line count
 * (OpenTUI's editor view already does the wrapping, including surrogate pairs
 * and wide glyphs) and applies the result.
 */

import {
  PROMPT_BASE_ROWS,
  PROMPT_BORDER_ROWS,
  PROMPT_CAP_FRACTION,
  PROMPT_IDLE_INPUT_ROWS,
} from "./geometry/index.js"

/** Tallest bordered box the prompt may ask for on a terminal of `rows` rows. */
export function promptBoxCapRows(terminalRows: number): number {
  const rows = Math.max(1, Math.floor(terminalRows))
  return Math.max(PROMPT_BASE_ROWS, Math.floor(rows * PROMPT_CAP_FRACTION))
}

/** Input rows to show for `visualLines` of wrapped content. */
export function promptInputRows(
  visualLines: number,
  terminalRows: number,
): number {
  const wanted = Math.max(PROMPT_IDLE_INPUT_ROWS, Math.floor(visualLines))
  const cap = promptBoxCapRows(terminalRows) - PROMPT_BORDER_ROWS
  return Math.max(1, Math.min(wanted, cap))
}

/** Bordered box rows to request from the geometry resolver. */
export function promptBoxRows(
  visualLines: number,
  terminalRows: number,
): number {
  return promptInputRows(visualLines, terminalRows) + PROMPT_BORDER_ROWS
}

/** True once the content no longer fits and the input is scrolling itself. */
export function promptIsScrolling(
  visualLines: number,
  terminalRows: number,
): boolean {
  return Math.floor(visualLines) > promptInputRows(visualLines, terminalRows)
}
