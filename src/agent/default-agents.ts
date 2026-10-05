import { directorProfiles } from "./directors/registry.js";
import type { AgentPlugin } from "./profile-types.js";

// Spawnable profiles = closed director fleet minus primary dispatch.
// Plugin/local profiles with the same id replace the closed director
// (CL-9917) — last enabled plugin / local file wins.
export const defaultAgentsPlugin: AgentPlugin = {
  agents: directorProfiles(),
};
