/**
 * Live SessionPort — binds OpenTUI shell outbound actions to injectable
 * host hooks (runner agentProxy send / interrupt / deliver). No React/Ink.
 */

import type { QueueItem, QueueKind } from "./session-queue.js"
import type { SessionPort } from "./runtime-bridge.js"

export type LiveSessionPortDeps = {
  /** Idle / immediate user text → agent send path. */
  send: (text: string) => void
  /** Hard interrupt current run (runner close/rebuild). */
  interrupt: () => void
  /**
   * Optional: drained queue/steer item at tool boundary (or idle).
   * Defaults to `send(text)` for both kinds — v1 runner shares send.
   */
  deliver?: (text: string, kind: QueueKind) => void
}

/**
 * SessionPort that forwards shell outbound actions to host deps.
 * Shell owns mid-run queue state; `enqueue` is a no-op here (kind lives on
 * `QueueItem` and is passed to `deliver` on drain).
 */
export function createLiveSessionPort(deps: LiveSessionPortDeps): SessionPort {
  return {
    sendImmediate: (text: string): void => {
      deps.send(text)
    },
    enqueue: (_text: string, _kind: QueueKind): void => {
      // Shell already enqueued; kind is preserved on QueueItem for deliver.
    },
    interrupt: (): void => {
      deps.interrupt()
    },
    deliver: (item: QueueItem): void => {
      if (deps.deliver) {
        deps.deliver(item.text, item.kind)
        return
      }
      deps.send(item.text)
    },
  }
}
