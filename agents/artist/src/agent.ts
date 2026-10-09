import {
  defineAgent as coreDefineAgent,
  type AgentDefinition,
} from "@intx/agent";
import { systemPrompt } from "./prompt.js";

export const agent: AgentDefinition = defineAgent();

export function defineAgent(): AgentDefinition {
  return coreDefineAgent({
    id: "artist",
    systemPrompt: systemPrompt.build(),
    tools: [],
    capabilities: [],
    inference: { sources: [] },
  });
}
