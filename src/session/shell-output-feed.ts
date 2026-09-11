/**
 * Bounded live-output tail of a running shell command.
 *
 * Pure and synchronous: the shell-guard plugin appends output chunks, the TUI
 * polls `snapshot()` on its sticky tick and paints the tail onto the pending
 * `run_shell` row. Nothing here is persisted; the whole feed is a display
 * affordance for the wait.
 */

/** Tail of output a feed keeps before the oldest chunk is dropped. */
export const SHELL_FEED_LIMIT_BYTES = 8 * 1024;

export interface ShellOutputFeed {
  append(chunk: string): void;
  /** The retained tail, oldest first. Empty string when nothing has landed. */
  snapshot(): string;
  /** Drop everything (a new foreground shell is about to run). */
  clear(): void;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function createShellOutputFeed(
  limitBytes: number = SHELL_FEED_LIMIT_BYTES,
): ShellOutputFeed {
  let chunks: string[] = [];
  let totalBytes = 0;
  const recompute = (): void => {
    while (totalBytes > limitBytes && chunks.length > 1) {
      const dropped = chunks.shift();
      totalBytes -= dropped === undefined ? 0 : byteLength(dropped);
    }
    // A single chunk over the limit is truncated to its tail so the bound
    // holds even when one write exceeds it.
    if (totalBytes > limitBytes && chunks.length === 1) {
      const only = chunks[0] ?? "";
      let cut = only;
      while (cut.length > 0 && byteLength(cut) > limitBytes) {
        cut = cut.slice(Math.ceil(cut.length / 2));
      }
      chunks = [cut];
      totalBytes = byteLength(cut);
    }
  };
  return {
    append(chunk: string): void {
      if (chunk.length === 0) return;
      chunks.push(chunk);
      totalBytes += byteLength(chunk);
      recompute();
    },
    snapshot(): string {
      return chunks.join("");
    },
    clear(): void {
      chunks = [];
      totalBytes = 0;
    },
  };
}
