import { appendFile } from "node:fs/promises";
import { join } from "node:path";

import type { ReactorEmittedEvent } from "@intx/inference";
import { getLogger } from "@intx/log";

import { LOG_NAMESPACE_ROOT } from "../branding.js";

/**
 * Partial-output capture for streaming inference cycles.
 *
 * The context store persists a turn only on inference.done, so a cycle that is
 * cancelled, aborted, or errors mid-stream leaves nothing on disk. The recorder
 * buffers the current cycle's streamed text in memory (no disk writes on the
 * happy path) and appends one record to `partial.jsonl` in the session context
 * dir when a cycle ends abnormally, so the output survives for diagnosis.
 */

export const PARTIAL_FILE = "partial.jsonl";

export type CycleTextRecorder = {
  /** Feed every stream event; buffers deltas, resets on done, flushes on error. */
  handleEvent: (event: ReactorEmittedEvent) => void;
  /** The buffered text of the current (unfinished) cycle. */
  text: () => string;
  /** Write the buffer to partial.jsonl with a reason, then reset it. */
  flush: (reason: string) => Promise<void>;
  /** Text of the most recent non-empty flush, for callers racing the auto-flush. */
  lastFlushedText: () => string;
};

export type CycleTextRecorderOpts = {
  /**
   * Reason stamped by the inference.error auto-flush. Callers that abort a
   * cycle themselves (repetition, deadline) resolve the real cause here — the
   * error event can beat the caller's own flush to the buffer.
   */
  resolveErrorFlushReason?: () => string;
};

export function createCycleTextRecorder(
  // Resolved per flush because the TUI rotates its session context dir in
  // place. Callers that rotate must flush before repointing the dir — the
  // recorder cannot tell which session a stale buffer belongs to.
  resolveContextDir: () => string,
  appendToken: (text: string, token: string) => string = (text, token) => text + token,
  opts: CycleTextRecorderOpts = {},
): CycleTextRecorder {
  let cycleText = "";
  let lastFlushed = "";

  const flush = async (reason: string): Promise<void> => {
    const text = cycleText;
    cycleText = "";
    if (text.trim().length === 0) return;
    lastFlushed = text;
    const record = JSON.stringify({ reason, chars: text.length, text });
    try {
      await appendFile(join(resolveContextDir(), PARTIAL_FILE), `${record}\n`, "utf8");
    } catch (err) {
      getLogger([LOG_NAMESPACE_ROOT, "session", "partial"]).warn(
        "failed to write partial stream output: {error}",
        { error: err instanceof Error ? err.message : String(err) },
      );
    }
  };

  const handleEvent = (event: ReactorEmittedEvent): void => {
    if (event.type === "inference.text.delta") {
      const token = (event.data as { token?: unknown }).token;
      if (typeof token === "string") cycleText = appendToken(cycleText, token);
      return;
    }
    if (event.type === "inference.done") {
      cycleText = "";
      return;
    }
    if (event.type === "inference.error") {
      void flush(opts.resolveErrorFlushReason?.() ?? "inference-error");
    }
  };

  return { handleEvent, text: () => cycleText, flush, lastFlushedText: () => lastFlushed };
}
