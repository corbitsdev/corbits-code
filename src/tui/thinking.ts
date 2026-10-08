/**
 * Reasoning chrome: a short wrapped preview while reasoning streams, one
 * line once it settles (full text behind expand).
 *
 * Reasoning is not the answer, so it never owns the screen.
 */

import { sliceToWidth, stringWidth, wrapLines } from "./view/height.js";

/** What a settled reasoning row remembers about the thinking it finished. */
export interface Thought {
  /** Wall time the reasoning took, in milliseconds. */
  readonly ms: number;
}

/**
 * Flattens whitespace; reveal counts in these units so paint and the
 * reveal clock agree.
 */
export function flattenReasoningText(text: string): string {
  return text.replace(/\s+/g, " ").trimStart();
}

/**
 * Below ~20 feels laggy, above ~40 is unreadable; 28 is fast-but-legible.
 */
export const REVEAL_CHARS_PER_SEC = 28;

/**
 * Bounded CoT — kept in the 8–12 band so mid-turn thought stays glanceable.
 */
export const LIVE_THINKING_MAX_LINES = 10;

/**
 * Advance the reveal toward arrived text at a bounded rate. Never exceeds
 * `availableChars` nor regresses, so a shrink cannot visibly rewind the row.
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
 * Short wrapped paragraph of the newest *revealed* text; omit `revealChars`
 * to show whatever arrived (fixtures).
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
      : flat.slice(
          0,
          Math.max(0, Math.min(flat.length, Math.floor(revealChars))),
        );
  if (revealed.length === 0) return [""];
  // Prefer the newest prose when the wrap would exceed the cap.
  const budget = linesCap * columns;
  const window =
    revealed.length > budget
      ? revealed.slice(revealed.length - budget).trimStart()
      : revealed;
  const wrapped = wrapLines(window, columns);
  return wrapped.slice(-linesCap);
}

/** Marker that a settled reasoning line holds back the rest of the text. */
const ELLIPSIS = "…";

/**
 * The *opening* of the chain of thought reads as a whole clause; the tail
 * is wherever the model stopped, usually a mid-sentence fragment.
 */
export function thinkingSettledLine(text: string, width: number): string {
  const flat = flattenReasoningText(text).trimEnd();
  const columns = Math.max(1, Math.floor(width));
  if (stringWidth(flat) <= columns) return flat;
  const room = Math.max(0, columns - stringWidth(ELLIPSIS));
  return `${sliceToWidth(flat, room).trimEnd()}${ELLIPSIS}`;
}
