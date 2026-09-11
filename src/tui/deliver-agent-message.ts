/**
 * Guards a queued/steer deliver against a mid-rebuild or closed agent. The
 * shell paints the delivered row and pops the queue item before this runs, so
 * a failure here must restore the operator payload or surface a notice —
 * a swallowed error here means the transcript claims delivery for a message
 * that never reached the agent.
 */
import { AgentClosedError } from "@intx/agent";

export const CLOSED_AGENT_NOTICE =
  "Message not delivered — the session agent closed before it arrived.";
export const CLOSED_AGENT_QUEUE_NOTICE = `${CLOSED_AGENT_NOTICE} It's back in the queue.`;
export const CLOSED_AGENT_PROMPT_NOTICE = `${CLOSED_AGENT_NOTICE} It's back in the prompt.`;

export interface DeliverAgentMessageDeps {
  getFatalBuildError: () => Error | null;
  deliverToLiveAgent: () => void | Promise<void>;
  onDeliverFailure: (message: string) => void;
  /**
   * Operator drain only. Called for AgentClosedError and for fatalBuildError
   * (never attempted). Internal delivers omit this so they notice without
   * restoring to the composer or queue.
   */
  onClosedWithoutDelivery?: () => void;
}

export async function deliverAgentMessage(
  deps: DeliverAgentMessageDeps,
): Promise<void> {
  const fatal = deps.getFatalBuildError();
  if (fatal !== null) {
    if (deps.onClosedWithoutDelivery !== undefined) {
      deps.onClosedWithoutDelivery();
      return;
    }
    deps.onDeliverFailure(`Message not delivered: ${fatal.message}`);
    return;
  }
  try {
    await deps.deliverToLiveAgent();
  } catch (err) {
    if (err instanceof AgentClosedError) {
      if (deps.onClosedWithoutDelivery !== undefined) {
        deps.onClosedWithoutDelivery();
        return;
      }
      deps.onDeliverFailure(CLOSED_AGENT_NOTICE);
      return;
    }
    deps.onDeliverFailure(
      `Message not delivered: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function deliverIfCurrent(
  stillCurrent: () => boolean,
  deps: DeliverAgentMessageDeps,
): Promise<void> {
  if (!stillCurrent()) return;
  const restore = deps.onClosedWithoutDelivery;
  await deliverAgentMessage({
    ...deps,
    ...(restore !== undefined
      ? {
          onClosedWithoutDelivery: () => {
            if (!stillCurrent()) return;
            restore();
          },
        }
      : {}),
  });
}
