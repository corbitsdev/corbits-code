/**
 * Guards a queued/steer deliver against a mid-rebuild agent. The shell paints
 * the delivered row and pops the queue item before this runs, so a failure
 * here must be surfaced — a swallowed error here means the transcript claims
 * delivery for a message that never reached the agent.
 */
export interface DeliverAgentMessageDeps {
  getFatalBuildError: () => Error | null;
  deliverToLiveAgent: () => void;
  onDeliverFailure: (message: string) => void;
}

export function deliverAgentMessage(deps: DeliverAgentMessageDeps): void {
  const fatal = deps.getFatalBuildError();
  if (fatal !== null) {
    deps.onDeliverFailure(`Message not delivered: ${fatal.message}`);
    return;
  }
  try {
    deps.deliverToLiveAgent();
  } catch (err) {
    deps.onDeliverFailure(
      `Message not delivered: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
