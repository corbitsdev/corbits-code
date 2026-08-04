/**
 * Enter/leave sub-agent observe chrome (commandMessage + enteredSessionId).
 *
 * The parent header already shows "Observing sub-agent · esc returns" while
 * focused on a child. Command messages are ephemeral toasts; leave-observe must
 * clear them so "Back to parent session" never sticks on the parent transcript
 * after focus returns (CL-4869).
 */

export type ObserveChromeState = {
  enteredSessionId: string | null;
  commandMessage: string | null;
};

/** Enter observe: focus the child session and flash a Viewing toast. */
export function enterObserveChrome(
  sessionId: string,
  agentId: string,
  description: string,
): ObserveChromeState {
  return {
    enteredSessionId: sessionId,
    commandMessage: `Viewing ${agentId}: ${description}`,
  };
}

/**
 * Leave observe: drop child focus and clear observe command chrome.
 * Must not leave a sticky "Back to parent session" on the parent session.
 */
export function leaveObserveChrome(): ObserveChromeState {
  return {
    enteredSessionId: null,
    commandMessage: null,
  };
}
