/**
 * Live SessionPort — binds OpenTUI shell outbound actions to injectable
 * host hooks (runner agentProxy send / interrupt / deliver). No React/Ink.
 */

import type { PendingImageAttachment } from "../tui/image-attachments.js"
import type { QueueItem, QueueKind } from "./session-queue.js"
import type { SessionPort } from "./runtime-bridge.js"

export type LiveSessionPortDeps = {
  /** Idle / immediate user text (plus pending images) → agent send path. */
  send: (
    text: string,
    attachments?: readonly PendingImageAttachment[],
  ) => void
  /** Hard interrupt current run (runner close/rebuild). */
  interrupt: () => void
  /**
   * Optional: drained queue/steer item at tool boundary (or idle).
   * Defaults to `send(text)` for both kinds — v1 runner shares send.
   */
  deliver?: (
    text: string,
    kind: QueueKind,
    attachments?: readonly PendingImageAttachment[],
  ) => void
}

/**
 * SessionPort that forwards shell outbound actions to host deps.
 * Shell owns mid-run queue state; `enqueue` is a no-op here (kind lives on
 * `QueueItem` and is passed to `deliver` on drain).
 */
export function createLiveSessionPort(deps: LiveSessionPortDeps): SessionPort {
  return {
    sendImmediate: (
      text: string,
      attachments?: readonly PendingImageAttachment[],
    ): void => {
      deps.send(text, attachments)
    },
    enqueue: (_text: string, _kind: QueueKind): void => {
      // Shell already enqueued; kind is preserved on QueueItem for deliver.
    },
    interrupt: (): void => {
      deps.interrupt()
    },
    deliver: (item: QueueItem): void => {
      if (deps.deliver) {
        deps.deliver(item.text, item.kind, item.attachments)
        return
      }
      deps.send(item.text, item.attachments)
    },
  }
}
