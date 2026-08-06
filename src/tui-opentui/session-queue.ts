/**
 * Mid-run queue / steer / interrupt state machine (interaction contract §3).
 * Pure data — no paint, no OpenTUI. Shell + demo own delivery and UI flash.
 */

import type { PendingImageAttachment } from "../tui/image-attachments.js"

export type QueueKind = "queue" | "steer"

export type QueueItem = {
  readonly id: string
  readonly text: string
  readonly kind: QueueKind
  readonly enqueuedAt: number
  /** Images attached to this message, delivered with it at the boundary. */
  readonly attachments?: readonly PendingImageAttachment[]
}

export type RunState = "idle" | "busy"

export type SessionQueueState = {
  readonly run: RunState
  readonly items: readonly QueueItem[]
  /** True after interrupt until consumer clears (status flash). */
  readonly interruptFlash: boolean
  /** Monotonic id seed for queue items. */
  readonly nextId: number
}

export function createSessionQueue(
  run: RunState = "busy",
): SessionQueueState {
  return {
    run,
    items: [],
    interruptFlash: false,
    nextId: 1,
  }
}

/** Pending badge count (queue + steer share one pool). */
export function badgeCount(state: SessionQueueState): number {
  return state.items.length
}

export function setRunState(
  state: SessionQueueState,
  run: RunState,
): SessionQueueState {
  if (state.run === run) return state
  return { ...state, run }
}

/**
 * Enqueue a mid-run message. Empty / whitespace-only is a no-op.
 * When idle, still accepts into the queue bag for tests; product shell
 * may route idle Enter as immediate send instead of calling this.
 */
export function enqueue(
  state: SessionQueueState,
  text: string,
  kind: QueueKind = "queue",
  now = Date.now(),
  attachments?: readonly PendingImageAttachment[],
): SessionQueueState {
  const t = text.trim()
  if (t.length === 0 && (attachments === undefined || attachments.length === 0)) {
    return state
  }
  const item: QueueItem = {
    id: `q${state.nextId}`,
    text: t,
    kind,
    enqueuedAt: now,
    ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
  }
  return {
    ...state,
    items: [...state.items, item],
    nextId: state.nextId + 1,
    interruptFlash: false,
  }
}

/** Steer = priority enqueue (same badge pool). */
export function enqueueSteer(
  state: SessionQueueState,
  text: string,
  now = Date.now(),
  attachments?: readonly PendingImageAttachment[],
): SessionQueueState {
  return enqueue(state, text, "steer", now, attachments)
}

/**
 * Hard interrupt: discard all pending queue + steer, clear flash flag set,
 * force run to idle (caller re-sets busy when a new run starts).
 */
export function interrupt(state: SessionQueueState): SessionQueueState {
  return {
    run: "idle",
    items: [],
    interruptFlash: true,
    nextId: state.nextId,
  }
}

export function clearInterruptFlash(
  state: SessionQueueState,
): SessionQueueState {
  if (!state.interruptFlash) return state
  return { ...state, interruptFlash: false }
}

/** Drain order: steers first (FIFO within class), then queue (FIFO). */
export function drainOrder(
  state: SessionQueueState,
): readonly QueueItem[] {
  const steers = state.items.filter((i) => i.kind === "steer")
  const queues = state.items.filter((i) => i.kind === "queue")
  return [...steers, ...queues]
}

/** Pop next delivery item (steer-first). */
export function drainOne(
  state: SessionQueueState,
): { state: SessionQueueState; item: QueueItem | null } {
  const order = drainOrder(state)
  const item = order[0] ?? null
  if (!item) return { state, item: null }
  return {
    state: {
      ...state,
      items: state.items.filter((i) => i.id !== item.id),
    },
    item,
  }
}
