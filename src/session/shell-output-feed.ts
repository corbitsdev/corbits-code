/** Bounded live-output tail of a running shell command. The shell-guard
 * plugin appends chunks; the TUI polls `snapshot()` on its sticky tick.
 * Nothing is persisted. */

/** Tail of output a feed keeps before the oldest chunk is dropped. */
export const SHELL_FEED_LIMIT_BYTES = 8 * 1024;

export interface ShellOutputFeed {
  append(chunk: string): void;
  /** The retained tail, oldest first. Empty string when nothing has landed. */
  snapshot(): string;
  /** Drop everything retained in this feed. */
  clear(): void;
}

/** Per-call live tails so parallel run_shells cannot share or wipe a sibling. */
export interface ShellOutputFeedMap {
  forCall(callId: string): ShellOutputFeed;
  get(callId: string): ShellOutputFeed | undefined;
  drop(callId: string): void;
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

export function createShellOutputFeedMap(): ShellOutputFeedMap {
  const feeds = new Map<string, ShellOutputFeed>();
  return {
    forCall(callId: string): ShellOutputFeed {
      let feed = feeds.get(callId);
      if (feed === undefined) {
        feed = createShellOutputFeed();
        feeds.set(callId, feed);
      }
      return feed;
    },
    get(callId: string): ShellOutputFeed | undefined {
      return feeds.get(callId);
    },
    drop(callId: string): void {
      feeds.delete(callId);
    },
  };
}
