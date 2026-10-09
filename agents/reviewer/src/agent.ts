import {
  defineAgent as coreDefineAgent,
  type AgentDefinition,
} from "@intx/agent";
import { systemPrompt } from "./prompt.js";

export const agent: AgentDefinition = defineAgent();

export function defineAgent(): AgentDefinition {
  return coreDefineAgent({
    id: "reviewer",
    systemPrompt: systemPrompt.build(),
    tools: [], // tool mounting is consumer/app-side; surface enforced by drift-guard
    capabilities: [],
    inference: { sources: [] },
  });
}
