import { directorProfiles } from "./directors/registry.js";
import type { AgentPlugin } from "./profile-types.js";

// Spawnable profiles = closed director fleet minus primary skywalker.
// Closed DIRECTOR_IDS are reserved: plugin/local profiles that collide are
// skipped at load (CL-7015) — no override or alias of the fleet.
export const defaultAgentsPlugin: AgentPlugin = {
  agents: directorProfiles(),
};
