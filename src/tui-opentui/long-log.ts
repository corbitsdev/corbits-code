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
export const MAX_RETAINED_STREAM_ROWS = 600

/** Rows to drop from the front of a log of this length to fit the cap. */
export function retentionOverflow(length: number): number {
  return Math.max(0, length - MAX_RETAINED_STREAM_ROWS)
}
