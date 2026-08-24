/**
 * Readline-style kill ring for the OpenTUI prompt.
 *
 * The prompt's text buffer lives in `@opentui/core`'s InputRenderable, which
 * already implements Ctrl+B/F/D, Ctrl+K/U/W (as one-shot deletes), Alt+D,
 * arrow motion, and Alt+B/F word motion natively (see
 * `defaultTextareaKeyBindings` in @opentui/core). What it does not have is a
 * kill ring: deleted text is simply discarded, so Ctrl+Y (yank) and Alt+Y
 * (yank-pop) have nothing to restore.
 *
 * This module is the pure, testable half of that gap: shell.ts calls the
 * native delete methods on the InputRenderable (so column/width handling
 * stays correct) and diffs the value/cursor before and after to learn what
 * was removed, then hands that text to `recordKill`. `beginYank` and
 * `rotateYank` hand back the text to splice in; shell.ts performs the splice
 * against the InputRenderable directly.
 *
 * Sole kill ring implementation (the former Ink-era src/tui/kill-ring.ts
 * copy was retired once the OpenTUI cutover made it dead code).
 */

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
  /** Buffer span occupied by the last yank; null unless the previous command was a yank. */
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

// Consecutive kills grow a single ring entry the way readline does: forward
// kills append, backward kills prepend, so Ctrl+K Ctrl+K ... Ctrl+Y restores
// the killed region in original order.
export function recordKill(
  ring: KillRing,
  text: string,
  direction: "forward" | "backward",
): KillRing {
  if (text.length === 0) return breakKillSequence(ring);
  const accumulating =
    (ring.lastAction === "kill-forward" || ring.lastAction === "kill-backward") &&
    ring.entries.length > 0;
  const entries = accumulating
    ? [
        direction === "forward" ? ring.entries[0]! + text : text + ring.entries[0]!,
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

/** Ctrl+Y: text to insert at the cursor, or null when nothing has been killed. */
export function beginYank(ring: KillRing, cursor: number): { ring: KillRing; text: string } | null {
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
 * Alt+Y immediately after a yank: the caller replaces the returned span with
 * the next-older kill. Rotation persists, so the next Ctrl+Y yanks that entry.
 */
export function rotateYank(
  ring: KillRing,
): { ring: KillRing; span: YankSpan; text: string } | null {
  if (ring.lastAction !== "yank" || ring.lastYankSpan === null) return null;
  if (ring.entries.length === 0) return null;
  const nextIndex = (ring.yankIndex + 1) % ring.entries.length;
  const text = ring.entries[nextIndex]!;
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

/**
 * Diff helper for forward kills (Ctrl+K, Alt+D): the cursor does not move
 * when text is removed ahead of it, so the killed text is the slice of the
 * pre-delete value starting at the pre-delete cursor, sized by however much
 * the buffer shrank.
 */
export function killedTextForward(
  beforeValue: string,
  beforeCursor: number,
  afterValue: string,
): string {
  const removedLen = beforeValue.length - afterValue.length;
  if (removedLen <= 0) return "";
  return beforeValue.slice(beforeCursor, beforeCursor + removedLen);
}

/**
 * Diff helper for backward kills (Ctrl+U, Ctrl+W): the cursor moves back to
 * where the deletion started, so the killed text is the slice of the
 * pre-delete value between the new cursor and the old one.
 */
export function killedTextBackward(
  beforeValue: string,
  beforeCursor: number,
  afterCursor: number,
): string {
  if (afterCursor >= beforeCursor) return "";
  return beforeValue.slice(afterCursor, beforeCursor);
}
