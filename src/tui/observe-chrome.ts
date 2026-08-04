/**
 * Enter/leave sub-agent observe chrome as one transition.
 *
 * `enteredSessionId` and `commandMessage` must move together: the parent header
 * already shows observe identity, and command toasts are ephemeral. Leave must
 * clear both so a toast never sticks on the parent after focus returns.
 */

export type ObserveChromeState = {
  enteredSessionId: string | null;
  commandMessage: string | null;
};

/** Focus a child session and flash a Viewing toast. */
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

/** Drop child focus and clear all observe command chrome. */
export function leaveObserveChrome(): ObserveChromeState {
  return {
    enteredSessionId: null,
    commandMessage: null,
  };
}
