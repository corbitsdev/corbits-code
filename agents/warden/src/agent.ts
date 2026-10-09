import {
  defineAgent as coreDefineAgent,
  type AgentDefinition,
} from "@intx/agent";

import { systemPrompt } from "./prompt.js";

export const agent: AgentDefinition = defineAgent();

export function defineAgent(): AgentDefinition {
  return coreDefineAgent({
    id: "warden",
    systemPrompt: systemPrompt.build(),
    tools: [],
    capabilities: [],
    inference: { sources: [] },
    tags: { fleet: "0.3.36", lane: "warden" },
  });
}
