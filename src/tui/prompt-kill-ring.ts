/**
 * Readline-style kill ring for the OpenTUI prompt.
 *
 * Textarea and Input delete actions discard the removed text (they return
 * only whether they handled the key). The shell snapshots the buffer, runs
 * the native delete, and records what `removedByDelete` says the buffer
 * actually lost — a cursor-offset read can name a grapheme `deleteRange`
 * snapped past or refused. `beginYank` / `rotateYank` hand back text for
 * the shell to splice in.
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

/**
 * Contiguous span `after` is missing from `before`.
 *
 * `deleteRange` no-ops or snaps when the caret sits inside a wide cell, and
 * `getTextRange` still returns the overlapping grapheme. Recording that
 * prediction yanks text the buffer never lost. `text` is empty when nothing
 * was deleted or the change is not a pure deletion. `at` is the code-unit
 * index of the span in `before` (and where it splices back into `after`).
 */
export function removedByDelete(
  before: string,
  after: string,
): { text: string; at: number } {
  if (after.length > before.length || before === after)
    return { text: "", at: 0 };
  let at = 0;
  while (at < after.length && before.charCodeAt(at) === after.charCodeAt(at)) {
    at += 1;
  }
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (
    afterEnd > at &&
    before.charCodeAt(beforeEnd - 1) === after.charCodeAt(afterEnd - 1)
  ) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  if (after !== `${before.slice(0, at)}${before.slice(beforeEnd)}`) {
    return { text: "", at: 0 };
  }
  return { text: before.slice(at, beforeEnd), at };
}
