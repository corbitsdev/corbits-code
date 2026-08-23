// Readline-style kill ring backing the prompt's kill and yank commands.
// Entries persist across kills and submissions; the transient fields track
// whether the previous command was a kill (so consecutive kills accumulate
// into one entry) or a yank (so Meta+Y can rotate through earlier kills).

export const KILL_RING_MAX = 10;

export interface YankSpan { start: number; end: number }

export interface KillRing {
  /** Killed strings, most recent first. */
  entries: string[];
  /** Ring entry inserted by the most recent yank; Meta+Y advances it. */
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
// kills append, backward kills prepend, so C-k C-k ... C-y restores the
// killed region in original order.
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

/** C-y: text to insert at the cursor, or null when nothing has been killed. */
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
 * Meta+Y immediately after a yank: the caller replaces the returned span with
 * the next-older kill. Rotation persists, so the next C-y yanks that entry.
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
