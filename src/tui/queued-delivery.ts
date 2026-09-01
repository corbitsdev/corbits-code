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

export interface RouteQueuedDeliveryArgs {
  send: (text: string, attachments?: readonly PendingImageAttachment[]) => void;
  deliverSteer: (text: string, attachments?: readonly PendingImageAttachment[]) => void;
  /**
   * True only while the bridge is draining steers at a live parent
   * tool.boundary (or inference.done with tools still outstanding). Read
   * when the deliver op runs, not captured at mount.
   */
  parentCycleLive: () => boolean;
}

export function routeQueuedDelivery(args: RouteQueuedDeliveryArgs): ProductHostDeliver {
  return (text, kind, attachments) => {
    if (kind === "steer" && args.parentCycleLive()) {
      args.deliverSteer(text, attachments);
      return;
    }
    args.send(text, attachments);
  };
}

export function createDeliveryGeneration() {
  let generation = 0;
  return {
    bump(): void {
      generation += 1;
    },
    capture(): () => boolean {
      const captured = generation;
      return () => captured === generation;
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
  ingest: (text: string, attachments: readonly PendingImageAttachment[]) => Promise<IngestedSteer>;
  /** Agent.deliver (or the sessionOps enqueue that wraps it). */
  deliver: (text: string, attachments: readonly PendingImageAttachment[]) => void;
  captureGeneration: () => () => boolean;
  onFailure: (err: unknown) => void;
}

export interface CreateLeftoverSendArgs {
  enqueue: (op: () => Promise<void>) => Promise<void>;
  ingest: (text: string, attachments: readonly PendingImageAttachment[]) => Promise<IngestedSteer>;
  /**
   * Post-ingest hop (agentProxy.send). Must not ingest again — leftover
   * ingest already ran in this wrapper.
   */
  send: (text: string, attachments: readonly PendingImageAttachment[]) => void;
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
  ingest: (text: string, attachments: readonly PendingImageAttachment[]) => Promise<IngestedSteer>;
  hop: (text: string, attachments: readonly PendingImageAttachment[]) => void;
  recordSent?: (text: string) => void;
  captureGeneration: () => () => boolean;
  onFailure: (err: unknown) => void;
}

function createGenerationGatedHop(
  args: GenerationGatedHopArgs,
): (text: string, attachments?: readonly PendingImageAttachment[]) => void {
  return (text, attachments) => {
    const stillCurrent = args.captureGeneration();
    const pending = attachments ?? [];
    void args
      .enqueue(async () => {
        if (!stillCurrent()) return;
        const ingested = await args.ingest(text, pending);
        if (!stillCurrent()) return;
        args.recordSent?.(text);
        args.hop(ingested.text, ingested.attachments);
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
): (text: string, attachments?: readonly PendingImageAttachment[]) => void {
  return createGenerationGatedHop({ ...args, hop: args.deliver });
}

/**
 * Leftover / queue drain hop: capture generation at hop time, ingest, then
 * send only if /clear|/new has not bumped. Operator Enter must not use this.
 */
export function createLeftoverSend(
  args: CreateLeftoverSendArgs,
): (text: string, attachments?: readonly PendingImageAttachment[]) => void {
  return createGenerationGatedHop({ ...args, hop: args.send });
}
