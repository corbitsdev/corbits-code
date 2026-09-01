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
