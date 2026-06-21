// Public contract for agent plugin authors.

export type CapabilityMode = "exclude" | "allow";

export type CapabilityFilter = {
  mode: CapabilityMode;
  tools: string[];
};

export type AgentProfile = {
  // Unique identifier, used in workflow steps as `agent: "greybeard"`.
  id: string;
  description?: string;
  // Provider tier for this agent. Resolved via settings.tiers to a concrete
  // provider and model assignment.
  tier?: "fast" | "standard" | "clever";
  // Optional tool restriction. Controls which tools the sub-agent can call.
  capabilities?: CapabilityFilter;
  // Appended to the sub-agent's base system prompt to specialize its behavior.
  systemPromptRole?: string;
  // Relative path to a markdown file whose content is loaded as systemPromptRole
  // at startup. Resolved relative to the profile source: the plugin directory for
  // plugin-contributed profiles, or .agents/agents/ for local profiles. When both
  // systemPromptRole and systemPromptPath are set, systemPromptRole wins.
  systemPromptPath?: string;
};

// The shape every agent plugin package must export as "plugin" or as the
// default export.
export type AgentPlugin = {
  agents: AgentProfile[];
};
