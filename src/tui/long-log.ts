/**
 * Retention budget for a long-running transcript. The paint tree tracks
 * `streamLog` 1:1 (shell.ts's repaintTranscriptWindow/paintAppendStreamRow),
 * so every retained row stays reachable by scrolling; this cap keeps that
 * array — and the paint tree — bounded.
 */

/**
 * Retained tail of a stream log. Display-only state — the agent's own context
 * is kept separately — but an unbounded array still costs memory and O(n)
 * snapshot/diff work on every append.
 */
export const MAX_RETAINED_STREAM_ROWS = 600;

/** Rows to drop from the front of a log of this length to fit the cap. */
export function retentionOverflow(length: number): number {
  return Math.max(0, length - MAX_RETAINED_STREAM_ROWS);
}

/**
 * Evict the oldest rows once `log` exceeds the retention cap and return the
 * new absolute base (the index `log[0]` now represents).
 *
 * Every index the bridge holds — tool-call rows, the open streaming row, the
 * retry boundary — is absolute (base + local position), so eviction only bumps
 * the base; it never rewrites a stored index.
 */
export function trimRetainedLog<T>(log: T[], base: number): number {
  const drop = retentionOverflow(log.length);
  if (drop <= 0) return base;
  log.splice(0, drop);
  return base + drop;
}

/**
 * Notice painted above the oldest retained row once the cap has evicted
 * anything. Unlike the collapse marker it replaces, scrolling never reveals
 * more — these rows are gone, not merely out of the window.
 *
 * `evicted` is the count of painted rows actually spliced from the log; do
 * not invent 1 to mean "older history exists on disk."
 */
export function evictedRowsNotice(evicted: number): string {
  return ` … ${evicted} earlier row${evicted === 1 ? "" : "s"} dropped (past the retention limit)`;
}

/**
 * Notice when older history exists on disk but no painted row was spliced.
 * Resume can load a truncated tail that still fits the cap; the marker must
 * still say this is not the start of history, without a fake count.
 */
export function unloadedHistoryNotice(): string {
  return " … earlier rows not loaded (past the retention limit)";
}
