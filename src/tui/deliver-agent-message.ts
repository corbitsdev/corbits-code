/**
 * Guards a queued/steer deliver against a mid-rebuild or closed agent. The shell
 * paints the delivered row and pops the queue item before this runs, so the
 * caller must settle ownership from the structured result — a swallowed failure
 * here means the transcript claims delivery for a message that never reached
 * the agent.
 */
import { AgentClosedError } from "@intx/agent";

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
