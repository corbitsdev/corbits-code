/**
 * Mid-run queue / steer / interrupt state machine (interaction contract §3).
 * Pure data — no paint, no OpenTUI. Shell + demo own delivery and UI flash.
 *
 * Product chords (CL-6290):
 *   - Enter mid-run → kind "steer" (soft steer; drain at tool.boundary)
 *   - Alt+Enter mid-run → kind "queue" (follow-up; drain only when run goes idle)
 * Internal "reinject" is a separate bridge/shell submit kind, not a QueueKind,
 * and no product chord wires it anymore — leave the path for tests/API only.
 */

import type { PendingImageAttachment } from "./image-attachments.js";

export type QueueKind = "queue" | "steer";

export interface QueueItem {
  readonly id: string;
  readonly text: string;
  readonly kind: QueueKind;
  readonly enqueuedAt: number;
  /** Images attached to this message, delivered with it at the boundary. */
  readonly attachments?: readonly PendingImageAttachment[];
}

export type RunState = "idle" | "busy";

export interface SessionQueueState {
  readonly run: RunState;
  readonly items: readonly QueueItem[];
  /** True after interrupt until consumer clears (status flash). */
  readonly interruptFlash: boolean;
  /** Monotonic id seed for queue items. */
  readonly nextId: number;
}

export function createSessionQueue(run: RunState = "idle"): SessionQueueState {
  return {
    run,
    items: [],
    interruptFlash: false,
    nextId: 1,
  };
}

/** Pending badge count (queue + steer share one pool for depth totals). */
export function badgeCount(state: SessionQueueState): number {
  return state.items.length;
}

/** Soft-steer pending count (Enter mid-run). */
export function steerCount(state: SessionQueueState): number {
  return state.items.filter((i) => i.kind === "steer").length;
}

/** Follow-up pending count (Alt+Enter mid-run). */
export function queueCount(state: SessionQueueState): number {
  return state.items.filter((i) => i.kind === "queue").length;
}

export function setRunState(state: SessionQueueState, run: RunState): SessionQueueState {
  if (state.run === run) return state;
  return { ...state, run };
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
  const t = text.trim();
  if (t.length === 0 && (attachments === undefined || attachments.length === 0)) {
    return state;
  }
  const item: QueueItem = {
    id: `q${state.nextId}`,
    text: t,
    kind,
    enqueuedAt: now,
    ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
  };
  return {
    ...state,
    items: [...state.items, item],
    nextId: state.nextId + 1,
    interruptFlash: false,
  };
}

/** Steer = priority enqueue (same badge pool). */
export function enqueueSteer(
  state: SessionQueueState,
  text: string,
  now = Date.now(),
  attachments?: readonly PendingImageAttachment[],
): SessionQueueState {
  return enqueue(state, text, "steer", now, attachments);
}

/**
 * Hard interrupt: stop the run, keep everything the operator queued. Typing a
 * correction and then interrupting so it lands sooner is the common shape of
 * this gesture, so discarding the queue destroyed exactly the input the
 * operator most wanted delivered. Pending items survive to the next drain
 * boundary; only the run state and the flash change here.
 */
export function interrupt(state: SessionQueueState): SessionQueueState {
  return {
    ...state,
    run: "idle",
    interruptFlash: true,
  };
}

export function clearInterruptFlash(state: SessionQueueState): SessionQueueState {
  if (!state.interruptFlash) return state;
  return { ...state, interruptFlash: false };
}

/**
 * Retract the most recently enqueued item, queue or steer alike. Last-only:
 * an operator who wants an earlier item gone has no path here (see
 * `applyShellCancelLast` for why that is the shipped scope, not an oversight).
 */
export function cancelLast(state: SessionQueueState): {
  state: SessionQueueState;
  item: QueueItem | null;
} {
  const item = state.items[state.items.length - 1] ?? null;
  if (item === null) return { state, item: null };
  return {
    state: { ...state, items: state.items.slice(0, -1) },
    item,
  };
}

/** Drain order: steers first (FIFO within class), then queue (FIFO). */
export function drainOrder(state: SessionQueueState): readonly QueueItem[] {
  const steers = state.items.filter((i) => i.kind === "steer");
  const queues = state.items.filter((i) => i.kind === "queue");
  return [...steers, ...queues];
}

/**
 * Pop next delivery item. When `kind` is set, only that class (FIFO within
 * class); otherwise full `drainOrder` (steer-first, then queue).
 */
export function drainOne(
  state: SessionQueueState,
  kind?: QueueKind,
): { state: SessionQueueState; item: QueueItem | null } {
  const order = kind === undefined ? drainOrder(state) : state.items.filter((i) => i.kind === kind);
  const item = order[0] ?? null;
  if (!item) return { state, item: null };
  return {
    state: {
      ...state,
      items: state.items.filter((i) => i.id !== item.id),
    },
    item,
  };
}

/** Drain every pending soft-steer; leave follow-ups untouched. */
export function drainSteersOnly(state: SessionQueueState): {
  state: SessionQueueState;
  drained: readonly QueueItem[];
} {
  const drained: QueueItem[] = [];
  let current = state;
  for (;;) {
    const next = drainOne(current, "steer");
    if (!next.item) break;
    drained.push(next.item);
    current = next.state;
  }
  return { state: current, drained };
}
