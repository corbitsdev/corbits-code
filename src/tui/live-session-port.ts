/**
 * Live SessionPort — binds OpenTUI shell outbound actions to injectable
 * host hooks (runner agentProxy send / interrupt / deliver). No React/Ink.
 */

import type { PendingImageAttachment } from "./image-attachments.js";
import type { QueueItem, QueueKind } from "./session-queue.js";
import type { SessionPort } from "./runtime-bridge.js";

export type SubmitClassification = "agent" | "local" | "empty";

export interface LiveSessionPortDeps {
  /** Idle / immediate user text (plus pending images) → host send path. */
  send: (text: string, attachments?: readonly PendingImageAttachment[]) => void;
  /**
   * Classify a submit without side effects so the bridge can keep local-only
   * lines (slash commands, /feedback capture) off the busy/queue path.
   * Defaults to "agent" when omitted.
   */
  classifySubmit?: (
    text: string,
    attachments?: readonly PendingImageAttachment[],
  ) => SubmitClassification;
  /** Hard interrupt current run (runner close/rebuild). */
  interrupt: () => void;
  /** Drained queue/steer item at tool boundary (or idle). Always forwarded. */
  deliver: (text: string, kind: QueueKind, attachments?: readonly PendingImageAttachment[]) => void;
}

/**
 * SessionPort that forwards shell outbound actions to host deps.
 * Shell owns mid-run queue state; `enqueue` is a no-op here (kind lives on
 * `QueueItem` and is passed to `deliver` on drain).
 */
export function createLiveSessionPort(deps: LiveSessionPortDeps): SessionPort {
  return {
    classifySubmit: (
      text: string,
      attachments?: readonly PendingImageAttachment[],
    ): SubmitClassification => {
      return deps.classifySubmit?.(text, attachments) ?? "agent";
    },
    sendImmediate: (text: string, attachments?: readonly PendingImageAttachment[]): void => {
      deps.send(text, attachments);
    },
    enqueue: (_text: string, _kind: QueueKind): void => {
      // Shell already enqueued; kind is preserved on QueueItem for deliver.
    },
    interrupt: (): void => {
      deps.interrupt();
    },
    deliver: (item: QueueItem): void => {
      deps.deliver(item.text, item.kind, item.attachments);
    },
  };
}
