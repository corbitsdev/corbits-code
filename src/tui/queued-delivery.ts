/**
 * Kind routing for drained queue items, plus a generation token so a
 * /clear|/new rotation can drop in-flight delivers that belonged to the
 * previous session. Kind routing lives here, not on SessionPort.
 *
 * Live inject (`deliverSteer` → Agent.deliver) is only for an in-flight
 * parent tool.boundary. Leftover steers at idle, idle-with-fleet, or
 * post-interrupt share the send path (sendQueue, inFlight, token refresh).
 */

import type { PendingImageAttachment } from "./image-attachments.js";
import type { ProductHostDeliver } from "./product-host.js";
import { ASK_DIRECTOR_WAKE_PREFIX } from "../subagent/fleet-report.js";
import { MAILBOX_MAIL_WAKE_PREFIX } from "../subagent/mailbox-mail-drive.js";
import { deliverAgentMessage } from "./deliver-agent-message.js";
import type { QueueItem } from "./session-queue.js";

export type QueuedDeliveryHop = (
  text: string,
  attachments?: readonly PendingImageAttachment[],
  original?: QueueItem,
) => void;

export interface RouteQueuedDeliveryArgs {
  send: QueuedDeliveryHop;
  deliverSteer: QueuedDeliveryHop;
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
  return (text, kind, attachments, original) => {
    if (kind === "steer" && args.parentCycleLive()) {
      args.deliverSteer(text, attachments, original);
      return;
    }
    args.send(text, attachments, original);
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
  /** Agent.deliver on the live agent (sync throw). Not enqueueAgentDeliver. */
  deliver: (
    text: string,
    attachments: readonly PendingImageAttachment[],
  ) => void | Promise<void>;
  captureGeneration: () => () => boolean;
  onFailure: (err: unknown) => void;
  getFatalBuildError?: () => Error | null;
  onUndelivered?: (item: QueueItem) => void;
}

export interface CreateLeftoverSendArgs {
  enqueue: (op: () => Promise<void>) => Promise<void>;
  ingest: (
    text: string,
    attachments: readonly PendingImageAttachment[],
  ) => Promise<IngestedSteer>;
  /**
   * Post-ingest hop (liveAgent.send, not agentProxy.send). Must not ingest
   * again — leftover ingest already ran in this wrapper. Must not awaitTail
   * the same sessionOps queue this hop is already running on.
   */
  send: (
    text: string,
    attachments: readonly PendingImageAttachment[],
  ) => void | Promise<void>;
  /**
   * Up/Down recall. Called with the original text only when the hop is
   * still current after ingest, so a /clear|/new drop is not recorded.
   */
  recordSent?: (text: string) => void;
  captureGeneration: () => () => boolean;
  onFailure: (err: unknown) => void;
  getFatalBuildError?: () => Error | null;
  onUndelivered?: (item: QueueItem) => void;
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
  ) => void | Promise<void>;
  recordSent?: (text: string) => void;
  captureGeneration: () => () => boolean;
  onFailure: (err: unknown) => void;
  getFatalBuildError?: () => Error | null;
  onUndelivered?: (item: QueueItem) => void;
}

function createGenerationGatedHop(
  args: GenerationGatedHopArgs,
): QueuedDeliveryHop {
  return (text, attachments, original) => {
    const stillCurrent = args.captureGeneration();
    const pending = attachments ?? [];
    const recovered = original;
    void args
      .enqueue(async () => {
        if (!stillCurrent()) return;
        const ingested = await args.ingest(text, pending);
        if (!stillCurrent()) return;
        args.recordSent?.(text);
        const restore = args.onUndelivered;
        await deliverAgentMessage({
          getFatalBuildError: args.getFatalBuildError ?? (() => null),
          deliverToLiveAgent: () =>
            args.hop(ingested.text, ingested.attachments),
          onDeliverFailure: (message) => args.onFailure(new Error(message)),
          ...(recovered !== undefined && restore !== undefined
            ? {
                onClosedWithoutDelivery: () => {
                  if (!stillCurrent()) return;
                  restore(recovered);
                },
              }
            : {}),
        });
      })
      .catch(args.onFailure);
  };
}

/**
 * Live inject: enqueue ingest, then deliver, in drain order. Previously
 * each item started ingest immediately, so Agent.deliver could reverse.
 */
export function createLiveSteerDeliver(
  args: CreateLiveSteerDeliverArgs,
): QueuedDeliveryHop {
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
): QueuedDeliveryHop {
  return createGenerationGatedHop({
    ...args,
    hop: args.send,
    ingest: async (text, pending) =>
      text.startsWith(ASK_DIRECTOR_WAKE_PREFIX) ||
      text.startsWith(MAILBOX_MAIL_WAKE_PREFIX)
        ? { text, attachments: pending }
        : args.ingest(text, pending),
  });
}
