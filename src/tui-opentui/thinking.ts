/**
 * Reasoning chrome: the one line a chain of thought occupies while it streams,
 * and what that same line keeps once it is done.
 *
 * Reasoning is not the answer, so it never gets to own the screen. While it
 * arrives it rides a single row whose window follows the newest text; once the
 * turn moves on that same row stops moving and simply stays, with the full text
 * one keypress away. The row goes quiet rather than transforming: nothing the
 * operator was reading is substituted out from under them.
 */

/** What a settled reasoning row remembers about the thinking it finished. */
export type Thought = {
  /** Wall time the reasoning took, in milliseconds. */
  readonly ms: number
}

/**
 * Whitespace-flattened reasoning text, matching what `thinkingScrollLine`
 * windows onto. Exposed so callers computing a reveal position (chars
 * available to reveal) count in the same units as the paint function.
 */
export function flattenReasoningText(text: string): string {
  return text.replace(/\s+/g, " ").trimStart()
}

/**
 * Characters per second the reveal position advances at while reasoning
 * streams. Picked by printing sample frames at 15/20/28/40/60 chars/sec and
 * reading them back: below ~20 the line feels laggy against a fast model,
 * above ~40 it is back to unreadable. 28 landed as fast-but-legible.
 */
export const REVEAL_CHARS_PER_SEC = 28

/**
 * Advance a reveal position toward the text that has actually arrived, capped
 * at a bounded reading rate. Never exceeds `availableChars` (can't outrun the
 * text) and never regresses (a shrinking available count — should not happen,
 * but the row must not visibly rewind if it does).
 */
export function advanceRevealChars(
  prevChars: number,
  availableChars: number,
  elapsedMs: number,
  charsPerSec: number = REVEAL_CHARS_PER_SEC,
): number {
  const clampedPrev = Math.min(prevChars, availableChars)
  if (elapsedMs <= 0) return clampedPrev
  const grown = clampedPrev + (elapsedMs / 1000) * charsPerSec
  return Math.min(availableChars, grown)
}

/**
 * Live reasoning as one row: whitespace flattened, windowed onto the newest
 * *revealed* text. `revealChars` is the bounded-rate reveal position computed
 * by `advanceRevealChars`; omitting it (settled rows, tests, fixtures) shows
 * the text in full, which is the old always-tail behaviour.
 */
export function thinkingScrollLine(
  text: string,
  width: number,
  revealChars?: number,
): string {
  const flat = flattenReasoningText(text)
  const columns = Math.max(1, Math.floor(width))
  const revealed =
    revealChars === undefined
      ? flat.length
      : Math.max(0, Math.min(flat.length, Math.floor(revealChars)))
  const visible = flat.slice(0, revealed)
  if (visible.length <= columns) return visible
  return visible.slice(visible.length - columns)
}

/** Marker that a settled reasoning line is holding back the rest of the text. */
const ELLIPSIS = "…"

/**
 * Settled reasoning as one line: the *opening* of the chain of thought, cut to
 * the row's columns. The opening is what the reasoning is about and reads as a
 * whole clause; the tail is wherever the model happened to stop, which is
 * usually a fragment mid-sentence. The rest stays behind the expand key.
 */
export function thinkingSettledLine(text: string, width: number): string {
  const flat = flattenReasoningText(text).trimEnd()
  const columns = Math.max(1, Math.floor(width))
  if (flat.length <= columns) return flat
  return `${flat.slice(0, Math.max(0, columns - ELLIPSIS.length)).trimEnd()}${ELLIPSIS}`
}
