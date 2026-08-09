import { directorProfiles } from "./directors/registry.js";
import type { AgentPlugin } from "./profile-types.js";

// Default agent profiles = closed director fleet (CL-5818). Repositories can
// override any id via .agents/agents/ or agent-kind plugins (higher precedence).
export const defaultAgentsPlugin: AgentPlugin = {
  agents: directorProfiles(),
};
