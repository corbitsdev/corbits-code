import {
  defineAgent as coreDefineAgent,
  type AgentDefinition,
} from "@intx/agent";
import { systemPrompt } from "./prompt.js";

/**
 * Shakespeare ready agent — `agent = defineAgent()` plus the named component
 * parts (director/tools/systemPrompt/config) form the whole package surface.
 */
export const agent: AgentDefinition = defineAgent();

export function defineAgent(): AgentDefinition {
  return coreDefineAgent({
    id: "shakespeare",
    systemPrompt: systemPrompt.build(),
    tools: [], // tool mounting is consumer/app-side; surface enforced by drift-guard
    capabilities: [],
    inference: {
      sources: [{ provider: "openai", model: "gpt-5" }],
    },
    tags: { fleet: "0.3.36", lane: "shakespeare" },
  });
}
