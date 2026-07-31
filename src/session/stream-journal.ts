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
};

export function createCycleTextRecorder(
  // Resolved per flush: the TUI rotates its session context dir in place, and
  // a partial must land in the directory of the session that produced it.
  resolveContextDir: () => string,
  appendToken: (text: string, token: string) => string = (text, token) => text + token,
): CycleTextRecorder {
  let cycleText = "";

  const flush = async (reason: string): Promise<void> => {
    const text = cycleText;
    cycleText = "";
    if (text.trim().length === 0) return;
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
      void flush("inference-error");
    }
  };

  return { handleEvent, text: () => cycleText, flush };
}
