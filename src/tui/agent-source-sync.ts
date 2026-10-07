import { AgentClosedError, type Agent } from "@intx/agent";
import type { InferenceSource } from "@intx/types/runtime";

// A reload can close the live agent before the replacement lands; pushing
// onto a closed agent must not surface as an uncaught exception.
export function setAgentSourceUnlessClosed(
  agent: Agent,
  source: InferenceSource,
): void {
  try {
    agent.setSource(source);
  } catch (err) {
    if (!(err instanceof AgentClosedError)) throw err;
  }
}
