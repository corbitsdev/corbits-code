/**
 * Guards a queued/steer deliver against a mid-rebuild agent. The shell paints
 * the delivered row and pops the queue item before this runs, so a failure
 * here must be surfaced — a swallowed error here means the transcript claims
 * delivery for a message that never reached the agent.
 */
export interface DeliverAgentMessageDeps {
  getFatalBuildError: () => Error | null;
  /**
   * Settles before any delivery. Gates the session's first request on startup
   * work that must not race request building — the Codex instructions refresh:
   * a late in-memory swap would change the request prefix and forfeit the
   * provider prompt cache for the rest of the session. Must never reject
   * (callers attach their own fallback handling).
   */
  ready?: Promise<void>;
  deliverToLiveAgent: () => void;
  onDeliverFailure: (message: string) => void;
}

export async function deliverAgentMessage(deps: DeliverAgentMessageDeps): Promise<void> {
  if (deps.ready !== undefined) await deps.ready;
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
