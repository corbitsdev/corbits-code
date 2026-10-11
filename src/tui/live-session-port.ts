/**
 * Live SessionPort: binds shell outbound actions to injectable host hooks
 * (send / interrupt / deliver). No React/Ink.
 */

import type { PendingImageAttachment } from "./image-attachments.js";
import type { DeliverySettle, QueueItem, QueueKind } from "./delivery-queue.js";
import type { SessionPort } from "./runtime-bridge.js";

export type SubmitClassification = "agent" | "local" | "empty";

export interface LiveSessionPortDeps {
  /** Idle / immediate user text (plus pending images) → host send path. */
  send: (text: string, attachments?: readonly PendingImageAttachment[]) => void;
  /**
   * Classify a submit without side effects; local-only lines (slash
   * commands, /feedback capture) stay off the busy/queue path. Defaults
   * to "agent".
   */
  classifySubmit?: (
    text: string,
    attachments?: readonly PendingImageAttachment[],
  ) => SubmitClassification;
  /** Hard interrupt current run (runner close/rebuild). */
  interrupt: () => void;
  /** Drained queue/steer item. Kind routing (live inject vs send) is the host's. */
  deliver: (
    text: string,
    kind: QueueKind,
    attachments?: readonly PendingImageAttachment[],
    settle?: DeliverySettle,
  ) => void;
}

/**
 * Forwards shell outbound actions to host deps. `enqueue` is a no-op: the
 * shell already enqueued, and the kind lives on `QueueItem` for `deliver`.
 */
export function createLiveSessionPort(deps: LiveSessionPortDeps): SessionPort {
  return {
    classifySubmit: (
      text: string,
      attachments?: readonly PendingImageAttachment[],
    ): SubmitClassification => {
      return deps.classifySubmit?.(text, attachments) ?? "agent";
    },
    sendImmediate: (
      text: string,
      attachments?: readonly PendingImageAttachment[],
    ): void => {
      deps.send(text, attachments);
    },
    enqueue: (_text: string, _kind: QueueKind): void => {
      // No-op; the shell already enqueued.
    },
    interrupt: (): void => {
      deps.interrupt();
    },
    deliver: (item: QueueItem, settle?: DeliverySettle): void => {
      deps.deliver(item.text, item.kind, item.attachments, settle);
    },
  };
}
