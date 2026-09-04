/**
 * Retention budget for a long-running transcript. The paint tree tracks
 * `streamLog` 1:1 (see shell.ts's repaintTranscriptWindow/paintAppendStreamRow)
 * so every retained row stays reachable by scrolling; this cap is what keeps
 * that array — and so the paint tree — bounded over a long session.
 */

/**
 * Retained tail of a stream log. Display-only state — the agent's own context
 * is kept separately — but an unbounded array still costs memory and O(n)
 * snapshot/diff work on every append over a long, tool-heavy session.
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
 * Every index the bridge holds onto — tool-call rows, the open streaming
 * row, the retry boundary — is absolute (base + local position), so eviction
 * only has to bump the base; it never has to rewrite a stored index.
 */
export function trimRetainedLog<T>(log: T[], base: number): number {
  const drop = retentionOverflow(log.length);
  if (drop <= 0) return base;
  log.splice(0, drop);
  return base + drop;
}

/**
 * Notice painted above the oldest retained row once the cap has evicted
 * anything. Unlike the pre-CL-5551 collapse marker it replaces, scrolling
 * never reveals more — these rows are gone, not merely out of the window.
 */
export function evictedRowsNotice(evicted: number): string {
  return ` … ${evicted} earlier row${evicted === 1 ? "" : "s"} dropped (past the retention limit)`;
}
