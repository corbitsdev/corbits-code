import type { AgentProfile } from "../agent/profiles.js";

export function upsertAgentProfile(profiles: AgentProfile[], profile: AgentProfile): AgentProfile[] {
  const next = profiles.filter((p) => p.id !== profile.id);
  next.push(profile);
  return next.sort((a, b) => a.id.localeCompare(b.id));
}

export function removeAgentProfile(profiles: AgentProfile[], id: string): AgentProfile[] {
  return profiles.filter((p) => p.id !== id);
}
