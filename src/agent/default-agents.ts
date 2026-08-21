import { directorProfiles } from "./directors/registry.js";
import type { AgentPlugin } from "./profile-types.js";

// Spawnable profiles = closed director fleet minus primary skywalker.
// Repositories can override any id via .agents/agents/ or agent-kind
// plugins (higher precedence).
export const defaultAgentsPlugin: AgentPlugin = {
  agents: directorProfiles(),
};
