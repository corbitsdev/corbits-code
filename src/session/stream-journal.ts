import { appendFile } from "node:fs/promises";
import { join } from "node:path";

import type { ReactorEmittedEvent } from "@intx/inference";
import { getLogger } from "@intx/log";

import { LOG_NAMESPACE_ROOT } from "../branding.js";
import { onTurnBoundary } from "../agent/reactor-events.js";

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

/** Cap on retained cycle text; older text is dropped from the front. */
export const CYCLE_TEXT_CAP_CHARS = 262_144;

/** Append a streamed token to the cycle buffer, keeping only the tail. */
export function appendCycleText(
  text: string,
  token: string,
  cap: number = CYCLE_TEXT_CAP_CHARS,
): string {
  const joined = text + token;
  return joined.length > cap ? joined.slice(joined.length - cap) : joined;
}

export type PartialFlushReason =
  | "repetition"
  | "deadline"
  | "cancelled"
  | "interrupted"
  | "rotation"
  | "exit"
  | "crashed"
  | "send-failed"
  | "inference-error";

export type CycleTextRecorder = {
  /** Feed every stream event; buffers deltas, resets on done, flushes on error. */
  handleEvent: (event: ReactorEmittedEvent) => void;
  /** The buffered text of the current (unfinished) cycle. */
  text: () => string;
  /** Write the buffer to partial.jsonl with a reason, then reset it. */
  flush: (reason: PartialFlushReason) => Promise<void>;
  /**
   * Close the recorder against a dead cycle and salvage its text. Marks the
   * recorder closed immediately (before draining), so any stray terminal
   * event delivered during the drain cannot auto-flush over this call's
   * reason label. Snapshots the buffer at entry, awaits `opts.drain` (if
   * given) so a delayed teardown finishes before the write, then flushes the
   * entry snapshot under `reason` and returns it. A second call on an
   * already-closed recorder is a no-op that returns "".
   */
  dispose: (reason: PartialFlushReason, opts?: { drain?: Promise<unknown> }) => Promise<string>;
  /** Reopen a closed recorder with an empty buffer for the next session. */
  reset: () => void;
};

export function createCycleTextRecorder(
  // Resolved per flush because the TUI rotates its session context dir in
  // place. Callers that rotate must flush before repointing the dir — the
  // recorder cannot tell which session a stale buffer belongs to.
  resolveContextDir: () => string,
): CycleTextRecorder {
  let cycleText = "";
  let closed = false;

  const writeRecord = async (reason: PartialFlushReason, text: string): Promise<void> => {
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

  const flush = async (reason: PartialFlushReason): Promise<void> => {
    const text = cycleText;
    cycleText = "";
    await writeRecord(reason, text);
  };

  const handleEvent = (event: ReactorEmittedEvent): void => {
    if (closed) return;
    if (event.type === "inference.text.delta") {
      const token = (event.data as { token?: unknown }).token;
      if (typeof token === "string") cycleText = appendCycleText(cycleText, token);
      return;
    }
    if (onTurnBoundary(event)) {
      cycleText = "";
      return;
    }
    if (event.type === "inference.error") {
      void flush("inference-error");
    }
  };

  const dispose = async (
    reason: PartialFlushReason,
    opts?: { drain?: Promise<unknown> },
  ): Promise<string> => {
    if (closed) return "";
    closed = true;
    const snapshot = cycleText;
    cycleText = "";
    if (opts?.drain !== undefined) await opts.drain.catch(() => undefined);
    await writeRecord(reason, snapshot);
    return snapshot;
  };

  const reset = (): void => {
    closed = false;
    cycleText = "";
  };

  return { handleEvent, text: () => cycleText, flush, dispose, reset };
}
