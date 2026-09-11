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
import type { AgentDeliveryResult } from "./deliver-agent-message.js";
import type { ProductHostDeliver } from "./product-host.js";
import { ASK_DIRECTOR_WAKE_PREFIX } from "../subagent/fleet-report.js";
import { MAILBOX_MAIL_WAKE_PREFIX } from "../subagent/mailbox-mail-drive.js";

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
