/**
 * Readline-style kill ring for the OpenTUI prompt.
 *
 * Textarea and Input delete actions discard the removed text (they return
 * only whether they handled the key). The ring reads that span from the
 * edit buffer — `getTextRange` on the cursor the native delete is about to
 * use — then the shell runs the native action and records the span via
 * `recordKill`. `beginYank` / `rotateYank` hand back text for the shell to
 * splice in.
 */

import type { PromptInput } from "./prompt-input.js";

export const KILL_RING_MAX = 10;

export interface YankSpan {
  start: number;
  end: number;
}

export interface KillRing {
  /** Killed strings, most recent first. */
  entries: string[];
  /** Ring entry inserted by the most recent yank; Alt+Y advances it. */
  yankIndex: number;
  lastAction: "kill-forward" | "kill-backward" | "yank" | "other";
  /** Buffer span occupied by the last yank; null unless the previous
   * command was a yank. */
  lastYankSpan: YankSpan | null;
}

export const emptyKillRing: KillRing = {
  entries: [],
  yankIndex: 0,
  lastAction: "other",
  lastYankSpan: null,
};

/** Any command that is not a kill or yank ends accumulation and rotation. */
export function breakKillSequence(ring: KillRing): KillRing {
  if (ring.lastAction === "other" && ring.lastYankSpan === null) return ring;
  return { ...ring, lastAction: "other", lastYankSpan: null };
}

// Consecutive kills grow one entry readline-style: forward appends, backward
// prepends, so repeated Ctrl+K then Ctrl+Y restores the region in order.
export function recordKill(
  ring: KillRing,
  text: string,
  direction: "forward" | "backward",
): KillRing {
  if (text.length === 0) return breakKillSequence(ring);
  const accumulating =
    (ring.lastAction === "kill-forward" ||
      ring.lastAction === "kill-backward") &&
    ring.entries.length > 0;
  const head = ring.entries[0];
  if (accumulating && head == null) throw new Error("kill ring entry missing");
  const entries =
    accumulating && head != null
      ? [
          direction === "forward" ? head + text : text + head,
          ...ring.entries.slice(1),
        ]
      : [text, ...ring.entries].slice(0, KILL_RING_MAX);
  return {
    entries,
    yankIndex: 0,
    lastAction: direction === "forward" ? "kill-forward" : "kill-backward",
    lastYankSpan: null,
  };
}

/**
 * Ctrl+Y: text to insert at the cursor, or null when nothing has been killed.
 */
export function beginYank(
  ring: KillRing,
  cursor: number,
): { ring: KillRing; text: string } | null {
  const index = ring.yankIndex < ring.entries.length ? ring.yankIndex : 0;
  const text = ring.entries[index];
  if (text === undefined) return null;
  return {
    text,
    ring: {
      ...ring,
      yankIndex: index,
      lastAction: "yank",
      lastYankSpan: { start: cursor, end: cursor + text.length },
    },
  };
}

/**
 * Alt+Y after a yank: the next-older kill replaces the returned span.
 * Rotation persists, so the next Ctrl+Y yanks that entry.
 */
export function rotateYank(
  ring: KillRing,
): { ring: KillRing; span: YankSpan; text: string } | null {
  if (ring.lastAction !== "yank" || ring.lastYankSpan === null) return null;
  if (ring.entries.length === 0) return null;
  const nextIndex = (ring.yankIndex + 1) % ring.entries.length;
  const text = ring.entries[nextIndex];
  if (text == null) return null;
  const span = ring.lastYankSpan;
  return {
    text,
    span,
    ring: {
      ...ring,
      yankIndex: nextIndex,
      lastAction: "yank",
      lastYankSpan: { start: span.start, end: span.start + text.length },
    },
  };
}

function rangeText(prompt: PromptInput, start: number, end: number): string {
  return prompt.editBuffer.getTextRange(start, end);
}

/** Span `deleteToLineEnd` is about to drop. The native call ignores a selection. */
export function readKillToLineEnd(prompt: PromptInput): string {
  const cursor = prompt.editBuffer.getCursorPosition();
  return rangeText(prompt, cursor.offset, prompt.editBuffer.getEOL().offset);
}

/**
 * Span `deleteToLineStart` is about to drop: the current line back to column
 * 0, or the preceding newline when the cursor is already at column 0.
 */
export function readKillToLineStart(prompt: PromptInput): string {
  const cursor = prompt.editBuffer.getCursorPosition();
  if (cursor.col > 0) {
    return rangeText(
      prompt,
      prompt.editBuffer.getLineStartOffset(cursor.row),
      cursor.offset,
    );
  }
  if (cursor.row > 0)
    return rangeText(prompt, cursor.offset - 1, cursor.offset);
  return "";
}

/** Span `deleteWordForward` is about to drop, including a live selection. */
export function readKillWordForward(prompt: PromptInput): string {
  if (prompt.hasSelection()) return prompt.getSelectedText();
  const cursor = prompt.editBuffer.getCursorPosition();
  return rangeText(
    prompt,
    cursor.offset,
    prompt.editBuffer.getNextWordBoundary().offset,
  );
}

/** Span `deleteWordBackward` is about to drop, including a live selection. */
export function readKillWordBackward(prompt: PromptInput): string {
  if (prompt.hasSelection()) return prompt.getSelectedText();
  const cursor = prompt.editBuffer.getCursorPosition();
  return rangeText(
    prompt,
    prompt.editBuffer.getPrevWordBoundary().offset,
    cursor.offset,
  );
}
