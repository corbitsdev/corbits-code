// Dispatch assembled agent — ready unit + package defineAgent wrapper. Calls
// `@intx/agent`'s `defineAgent` directly (no Corbits bridge). Tool mounting is
// consumer/app-side: `tools` here is [] (the allowlist surface is exported from
// `./toolset.js` and wired by the app harness).

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
    tags: { fleet: "0.3.36", lane: "dispatch" },
  });
}
