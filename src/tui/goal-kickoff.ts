import { goalKickoffUserMessage } from "../agent/goal.js";

export type GoalKickoffDeps = {
  /**
   * Deliver the kickoff message down the same path a typed prompt takes.
   * Must serialize behind any in-flight turn so a goal set mid-run cannot
   * corrupt it. The ordinary send path already echoes the sent message into
   * the transcript in full (the same way any operator prompt does), so
   * kickoff needs no separate echo of its own — a second copy would only
   * duplicate it.
   */
  send: (text: string) => Promise<unknown>;
  onSendFailure: (err: unknown) => void;
};

/**
 * Builds the `/goal` kickoff handler: turns a set/resume into the lifecycle
 * message the agent needs to actually start working, and sends it through
 * the ordinary send path.
 */
export function createGoalKickoff(deps: GoalKickoffDeps): (condition: string, phase?: "set" | "resume") => void {
  return (condition, phase = "set") => {
    const message = goalKickoffUserMessage(condition, phase);
    void deps.send(message).catch(deps.onSendFailure);
  };
}
