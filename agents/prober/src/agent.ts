import {
  defineAgent as coreDefineAgent,
  type AgentDefinition,
} from "@intx/agent";
import { systemPrompt } from "./prompt.js";

export const agent: AgentDefinition = defineAgent();

export function defineAgent(): AgentDefinition {
  return coreDefineAgent({
    id: "prober",
    systemPrompt: systemPrompt.build(),
    tools: [],
    capabilities: [],
    inference: {
      sources: [{ provider: "openai", model: "gpt-5" }],
    },
    tags: { fleet: "0.3.36", lane: "prober" },
  });
}