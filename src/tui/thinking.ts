/**
 * Reasoning chrome: a short wrapped preview while thought streams, and a
 * one-line opener once it settles (full text behind expand).
 *
 * Reasoning is not the answer, so it never owns the screen. Live text used to
 * ride a single sideways-scrolling row; that was unreadable. Now the newest
 * revealed prose wraps into a bounded inset paragraph (hard-capped — never an
 * unbounded dump). Once the turn moves on the row collapses to its opening
 * clause — same expand path as before.
 */

import { sliceToWidth, stringWidth, wrapLines } from "./view/height.js";

/** What a settled reasoning row remembers about the thinking it finished. */
export interface Thought {
  /** Wall time the reasoning took, in milliseconds. */
  readonly ms: number;
}

/**
 * Whitespace-flattened reasoning text. Reveal position counts in these units
 * so paint and the reveal clock agree.
 */
export function flattenReasoningText(text: string): string {
  return text.replace(/\s+/g, " ").trimStart();
}

/**
 * Characters per second the reveal position advances at while reasoning
 * streams. Picked by printing sample frames at 15/20/28/40/60 chars/sec and
 * reading them back: below ~20 the line feels laggy against a fast model,
 * above ~40 it is back to unreadable. 28 landed as fast-but-legible and still
 * reads well against the taller live preview.
 */
export const REVEAL_CHARS_PER_SEC = 28;

/**
 * How many wrapped lines a live reasoning preview may claim. Hard bound — the
 * preview never paints unbounded CoT into the transcript. Raised into the
 * 8–12 band so mid-turn chain-of-thought is glanceable without inventing a
 * separate stream lane.
 */
export const LIVE_THINKING_MAX_LINES = 10;

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
  const clampedPrev = Math.min(prevChars, availableChars);
  if (elapsedMs <= 0) return clampedPrev;
  const grown = clampedPrev + (elapsedMs / 1000) * charsPerSec;
  return Math.min(availableChars, grown);
}

/**
 * Live reasoning as a short wrapped paragraph of the newest *revealed* text.
 * `revealChars` is the bounded-rate reveal position from `advanceRevealChars`;
 * omitting it shows whatever has arrived so far (tests/fixtures).
 */
export function thinkingLivePreviewLines(
  text: string,
  width: number,
  revealChars?: number,
  maxLines: number = LIVE_THINKING_MAX_LINES,
): string[] {
  const columns = Math.max(1, Math.floor(width));
  const linesCap = Math.max(1, Math.floor(maxLines));
  const flat = flattenReasoningText(text);
  const revealed =
    revealChars === undefined
      ? flat
      : flat.slice(0, Math.max(0, Math.min(flat.length, Math.floor(revealChars))));
  if (revealed.length === 0) return [""];
  // Prefer the newest prose when the wrap would exceed the cap.
  const budget = linesCap * columns;
  const window =
    revealed.length > budget ? revealed.slice(revealed.length - budget).trimStart() : revealed;
  const wrapped = wrapLines(window, columns);
  return wrapped.slice(-linesCap);
}

/** Marker that a settled reasoning line is holding back the rest of the text. */
const ELLIPSIS = "…";

/**
 * Settled reasoning as one line: the *opening* of the chain of thought, cut to
 * the row's columns. The opening is what the reasoning is about and reads as a
 * whole clause; the tail is wherever the model happened to stop, which is
 * usually a fragment mid-sentence. The rest stays behind the expand key.
 */
export function thinkingSettledLine(text: string, width: number): string {
  const flat = flattenReasoningText(text).trimEnd();
  const columns = Math.max(1, Math.floor(width));
  if (stringWidth(flat) <= columns) return flat;
  const room = Math.max(0, columns - stringWidth(ELLIPSIS));
  return `${sliceToWidth(flat, room).trimEnd()}${ELLIPSIS}`;
}
