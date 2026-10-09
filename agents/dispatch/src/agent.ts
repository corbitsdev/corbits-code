import {
  defineAgent as coreDefineAgent,
  type AgentDefinition,
} from "@intx/agent";

import { systemPrompt } from "./prompt.js";

export const agent: AgentDefinition = defineAgent();

/** Package convenience wrapper → `AgentDefinition` for `runLocal` authoring. */
export function defineAgent(): AgentDefinition {
  return coreDefineAgent({
    id: "dispatch",
    systemPrompt: systemPrompt.build(),
    tools: [],
    capabilities: [],
    inference: { sources: [] },
  });
}
