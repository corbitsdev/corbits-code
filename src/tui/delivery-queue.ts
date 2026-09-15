/**
 * Delivery queue: mid-run queue / steer / interrupt state machine, the serial
 * operation chain that drains it, and the generation-gated delivery hops.
 *
 * One module: `session-queue.ts` (pure item state), `session-operation-queue.ts`
 * (serial promise chain), and `queued-delivery.ts` (kind routing + delivery
 * hops) were three slices of the same drain pipeline. No behavior change —
 * sections below are verbatim moves.
 *
 * Mid-run queue / steer / interrupt state machine (interaction contract §3).
 * Pure data — no paint, no OpenTUI. Shell + demo own delivery and UI flash.
 *
 * Product chords (CL-6290):
 *   - Enter mid-run → kind "steer" (soft steer; drain at tool.boundary)
 *   - Alt+Enter mid-run → kind "queue" (follow-up; drain only when run goes idle)
 * Internal "reinject" is a separate bridge/shell submit kind, not a QueueKind,
 * and no product chord wires it anymore — leave the path for tests/API only.
 */

import { AgentClosedError } from "@intx/agent";
import type { PendingImageAttachment } from "./image-attachments.js";
import type { ProductHostDeliver } from "./product-host.js";
import { ASK_DIRECTOR_WAKE_PREFIX } from "../subagent/fleet-report.js";
import { MAILBOX_MAIL_WAKE_PREFIX } from "../subagent/mailbox-mail-drive.js";

export type AgentDeliveryNotDeliveredReason =
  | "agent-closed"
  | "session-unavailable"
  | "superseded"
  | "preparation-failed";

export type AgentDeliveryResult =
  | { readonly status: "accepted" }
  | {
      readonly status: "not-delivered";
      readonly reason: AgentDeliveryNotDeliveredReason;
      readonly detail: string;
    }
  | {
      readonly status: "uncertain";
      readonly detail: string;
    };

export interface DeliverAgentMessageDeps {
  getFatalBuildError: () => Error | null;
  deliverToLiveAgent: () => void;
}

/**
 * Guards a queued/steer deliver against a mid-rebuild or closed agent. The
 * shell paints the delivered row and pops the queue item before this runs, so
 * the caller must settle ownership from the structured result — a swallowed
 * failure here means the transcript claims delivery for a message that never
 * reached the agent.
 */
export async function deliverAgentMessage(
  deps: DeliverAgentMessageDeps,
): Promise<AgentDeliveryResult> {
  const fatal = deps.getFatalBuildError();
  if (fatal !== null) {
    return {
      status: "not-delivered",
      reason: "session-unavailable",
      detail: fatal.message,
    };
  }
  try {
    deps.deliverToLiveAgent();
    return { status: "accepted" };
  } catch (err) {
    if (err instanceof AgentClosedError) {
      return {
        status: "not-delivered",
        reason: "agent-closed",
        detail: err.message,
      };
    }
    return {
      status: "uncertain",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Settles a deliver that was enqueued on the serial operation queue against
 * the shoot generation captured at enqueue time. The queue is FIFO with no
 * preemption, so a deliver queued ahead of a reload still executes after the
 * reload has replaced the agent — the generation must be re-checked when the
 * queued closure runs, not just when it enqueues. A stale deliver takes the
 * `onStale` path (the caller reports `not-delivered`); a current deliver runs
 * the real settle. This is what closes the reload-vs-async-deliver race: a
 * reload that lands while a continuation answer is queued wins, and the stale
 * answer is dropped instead of reaching the replaced agent.
 */
export async function runGenerationGuardedDeliver(options: {
  stillCurrent: () => boolean;
  run: () => Promise<AgentDeliveryResult>;
  onStale: () => AgentDeliveryResult;
}): Promise<AgentDeliveryResult> {
  if (!options.stillCurrent()) {
    return options.onStale();
  }
  return options.run();
}

/** Operator-facing copy for a settled delivery that did not accept. */
export function deliveryResultNotice(
  result: Exclude<AgentDeliveryResult, { status: "accepted" }>,
  disposition: "restored" | "deferred" | "none" = "none",
): string {
  if (result.status === "uncertain") {
    const base = `Delivery failed: ${result.detail}. Delivery status is uncertain; review the transcript before sending again.`;
    return appendDisposition(base, disposition);
  }
  if (result.reason === "agent-closed") {
    if (disposition === "restored") {
      return "Message not delivered because the agent closed. It is back in the prompt; press Enter to send it.";
    }
    if (disposition === "deferred") {
      return "Message not delivered because the agent closed. Your current draft is unchanged; the message will return to the prompt after you send it.";
    }
    return "Message not delivered because the agent closed.";
  }
  const base = `Message not delivered: ${result.detail}`;
  return appendDisposition(base, disposition);
}

function appendDisposition(
  base: string,
  disposition: "restored" | "deferred" | "none",
): string {
  if (disposition === "restored") {
    return `${base} It is back in the prompt; press Enter to send it.`;
  }
  if (disposition === "deferred") {
    return `${base} Your current draft is unchanged; the message will return to the prompt after you send it.`;
  }
  return base;
}

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

export function setRunState(
  state: SessionQueueState,
  run: RunState,
): SessionQueueState {
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
  if (
    t.length === 0 &&
    (attachments === undefined || attachments.length === 0)
  ) {
    return state;
  }
  const item: QueueItem = {
    id: `q${state.nextId}`,
    text: t,
    kind,
    enqueuedAt: now,
    ...(attachments !== undefined && attachments.length > 0
      ? { attachments }
      : {}),
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

export function clearInterruptFlash(
  state: SessionQueueState,
): SessionQueueState {
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

/**
 * Retract a specific item by id — the pending column's per-row drop, where the
 * operator picked exactly which held message to kill rather than the newest.
 */
export function cancelItem(
  state: SessionQueueState,
  id: string,
): { state: SessionQueueState; item: QueueItem | null } {
  const index = state.items.findIndex((item) => item.id === id);
  const item = state.items[index] ?? null;
  if (item === null) return { state, item: null };
  return {
    state: {
      ...state,
      items: [...state.items.slice(0, index), ...state.items.slice(index + 1)],
    },
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
  const order =
    kind === undefined
      ? drainOrder(state)
      : state.items.filter((i) => i.kind === kind);
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

// Serial promise chain for session-scoped operations (reload, interrupt, deliver).
// Each task runs after the previous one settles; failures do not block the tail.

export interface SessionOperationQueue {
  /** Enqueue an async operation; returns a promise for this operation's settlement. */
  enqueue: (op: () => Promise<void>) => Promise<void>;
  /** Await the tail of the queue (all prior operations finished or failed). */
  awaitTail: () => Promise<void>;
}

export function createSessionOperationQueue(): SessionOperationQueue {
  let tail: Promise<void> = Promise.resolve();

  const enqueue = (op: () => Promise<void>): Promise<void> => {
    tail = tail.then(op, op);
    return tail;
  };

  return {
    enqueue,
    awaitTail: () => tail.catch(() => undefined),
  };
}

/**
 * Kind routing for drained queue items, plus a generation token so a
 * /clear|/new rotation can drop in-flight delivers that belonged to the
 * previous session. Kind routing lives here, not on SessionPort.
 *
 * Live inject (`deliverSteer` → Agent.deliver) is only for an in-flight
 * parent tool.boundary. Leftover steers at idle, idle-with-fleet, or
 * post-interrupt share the send path (sendQueue, inFlight, token refresh).
 */

export type DeliverySettle = (result: AgentDeliveryResult) => void;
type MaybeAsyncDeliveryResult =
  | Promise<AgentDeliveryResult>
  | ReturnType<() => void>;

export interface RouteQueuedDeliveryArgs {
  send: (
    text: string,
    attachments?: readonly PendingImageAttachment[],
    settle?: DeliverySettle,
  ) => void;
  deliverSteer: (
    text: string,
    attachments?: readonly PendingImageAttachment[],
    settle?: DeliverySettle,
  ) => void;
  /**
   * True only while the bridge is draining steers at a live parent
   * tool.boundary (or inference.done with tools still outstanding). Read
   * when the deliver op runs, not captured at mount.
   */
  parentCycleLive: () => boolean;
}

export function routeQueuedDelivery(
  args: RouteQueuedDeliveryArgs,
): ProductHostDeliver {
  return (text, kind, attachments, settle) => {
    if (kind === "steer" && args.parentCycleLive()) {
      args.deliverSteer(text, attachments, settle);
      return;
    }
    args.send(text, attachments, settle);
  };
}

export const SESSION_IDENTITY_ABORT_REASON =
  "session identity changed; approval request denied";

export function createDeliveryGeneration(onBump?: () => void) {
  let generation = 0;
  let identity = new AbortController();
  return {
    bump(): void {
      generation += 1;
      const previous = identity;
      identity = new AbortController();
      previous.abort(SESSION_IDENTITY_ABORT_REASON);
      onBump?.();
    },
    capture(): () => boolean {
      const captured = generation;
      return () => captured === generation;
    },
    signal(): AbortSignal {
      return identity.signal;
    },
  };
}

export interface IngestedSteer {
  readonly text: string;
  readonly attachments: readonly PendingImageAttachment[];
}

export interface CreateLiveSteerDeliverArgs {
  /**
   * FIFO session queue. Ingest must run on this queue — not in a
   * fire-and-forget IIFE — so two steers at one boundary cannot reverse
   * if the second ingest finishes first.
   */
  enqueue: (op: () => Promise<void>) => Promise<void>;
  ingest: (
    text: string,
    attachments: readonly PendingImageAttachment[],
  ) => Promise<IngestedSteer>;
  /**
   * Agent.deliver hop. When `settle` is provided, the hop owns reporting the
   * eventual AgentDeliveryResult (accepted / closed / uncertain).
   */
  deliver: (
    text: string,
    attachments: readonly PendingImageAttachment[],
    settle?: DeliverySettle,
  ) => void;
  captureGeneration: () => () => boolean;
  onFailure: (err: unknown) => void;
}

export interface CreateLeftoverSendArgs {
  enqueue: (op: () => Promise<void>) => Promise<void>;
  ingest: (
    text: string,
    attachments: readonly PendingImageAttachment[],
  ) => Promise<IngestedSteer>;
  /**
   * Post-ingest hop (agentProxy.send). Must not ingest again — leftover
   * ingest already ran in this wrapper.
   */
  send: (
    text: string,
    attachments: readonly PendingImageAttachment[],
  ) => MaybeAsyncDeliveryResult;
  /**
   * Up/Down recall. Called with the original text only when the hop is
   * still current after ingest, so a /clear|/new drop is not recorded.
   */
  recordSent?: (text: string) => void;
  captureGeneration: () => () => boolean;
  onFailure: (err: unknown) => void;
}

interface GenerationGatedHopArgs {
  enqueue: (op: () => Promise<void>) => Promise<void>;
  ingest: (
    text: string,
    attachments: readonly PendingImageAttachment[],
  ) => Promise<IngestedSteer>;
  hop: (
    text: string,
    attachments: readonly PendingImageAttachment[],
    settle?: DeliverySettle,
  ) => MaybeAsyncDeliveryResult;
  /** Leftover/send settles from the send promise; live steer uses the callback. */
  settleFromHopResult?: boolean;
  recordSent?: (text: string) => void;
  captureGeneration: () => () => boolean;
  onFailure: (err: unknown) => void;
}

function settleOnce(
  settle: DeliverySettle | undefined,
  result: AgentDeliveryResult,
): void {
  settle?.(result);
}

function createGenerationGatedHop(
  args: GenerationGatedHopArgs,
): (
  text: string,
  attachments?: readonly PendingImageAttachment[],
  settle?: DeliverySettle,
) => void {
  return (text, attachments, settle) => {
    const stillCurrent = args.captureGeneration();
    const pending = attachments ?? [];
    let settled = false;
    const finish = (result: AgentDeliveryResult): void => {
      if (settled) return;
      settled = true;
      settleOnce(settle, result);
    };
    void args
      .enqueue(async () => {
        if (!stillCurrent()) {
          finish({
            status: "not-delivered",
            reason: "superseded",
            detail: SESSION_IDENTITY_ABORT_REASON,
          });
          return;
        }
        let ingested: IngestedSteer;
        try {
          ingested = await args.ingest(text, pending);
        } catch (err) {
          finish({
            status: "not-delivered",
            reason: "preparation-failed",
            detail: err instanceof Error ? err.message : String(err),
          });
          if (settle === undefined) args.onFailure(err);
          return;
        }
        if (!stillCurrent()) {
          finish({
            status: "not-delivered",
            reason: "superseded",
            detail: SESSION_IDENTITY_ABORT_REASON,
          });
          return;
        }
        args.recordSent?.(text);
        if (args.settleFromHopResult === true) {
          const result = await args.hop(ingested.text, ingested.attachments);
          finish(result ?? { status: "accepted" });
          return;
        }
        // Live steer: hop receives settle and reports the eventual result.
        args.hop(ingested.text, ingested.attachments, (result) => {
          finish(result);
        });
      })
      .catch((err: unknown) => {
        finish({
          status: "uncertain",
          detail: err instanceof Error ? err.message : String(err),
        });
        if (settle === undefined) args.onFailure(err);
      });
  };
}

/**
 * Live inject: enqueue ingest, then deliver, in drain order. Previously
 * each item started ingest immediately, so Agent.deliver could reverse.
 */
export function createLiveSteerDeliver(
  args: CreateLiveSteerDeliverArgs,
): (
  text: string,
  attachments?: readonly PendingImageAttachment[],
  settle?: DeliverySettle,
) => void {
  return createGenerationGatedHop({ ...args, hop: args.deliver });
}

/**
 * Leftover / queue drain hop: capture generation at hop time, ingest, then
 * send only if /clear|/new has not bumped. Operator Enter must not use this.
 * `ask_director wake` leftover is passed through raw so worker @paths and
 * image mentions are not rewritten as operator attachments.
 */
export function createLeftoverSend(
  args: CreateLeftoverSendArgs,
): (
  text: string,
  attachments?: readonly PendingImageAttachment[],
  settle?: DeliverySettle,
) => void {
  return createGenerationGatedHop({
    ...args,
    hop: args.send,
    settleFromHopResult: true,
    ingest: async (text, pending) =>
      text.startsWith(ASK_DIRECTOR_WAKE_PREFIX) ||
      text.startsWith(MAILBOX_MAIL_WAKE_PREFIX)
        ? { text, attachments: pending }
        : args.ingest(text, pending),
  });
}
