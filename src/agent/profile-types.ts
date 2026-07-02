// Public contract for agent plugin authors (re-exported from agent/profiles.ts).

export type CapabilityMode = "exclude" | "allow";

export type CapabilityFilter = {
  mode: CapabilityMode;
  tools: string[];
};

export type AgentProfile = {
  id: string;
  description?: string;
  tier?: "fast" | "standard" | "clever";
  capabilities?: CapabilityFilter;
  systemPromptRole?: string;
  systemPromptPath?: string;
};

export type AgentPlugin = {
  agents: AgentProfile[];
};