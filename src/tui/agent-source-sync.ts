import { AgentClosedError, type Agent } from "@intx/agent";
import type { InferenceSource } from "@intx/types/runtime";

// Provider switches can land while a reload has closed the live agent but not yet
// swapped in the replacement. The proxy still records the selection in liveSource;
// pushing onto a closed agent must not surface as an uncaught exception.
export function setAgentSourceUnlessClosed(agent: Agent, source: InferenceSource): void {
  try {
    agent.setSource(source);
  } catch (err) {
    if (!(err instanceof AgentClosedError)) throw err;
  }
}
