// A minimal worked example of a `kind: "agent"` plugin. It contributes one
// sub-agent profile, "scout", that can be dispatched via `spawn_agent` with
// `agent: "scout"`. The profile restricts the sub-agent to read-only tools and
// assigns it to the "fast" tier (resolved via settings.tiers to a concrete
// provider and model). Kept self-contained — it declares only the small slice
// of the AgentProfile contract it needs, so the same pattern works for an
// out-of-tree plugin without importing core types.

interface AgentProfile {
  id: string;
  description?: string;
  tier?: "fast" | "standard" | "clever";
  capabilities?: { mode: "exclude" | "allow"; tools: string[] };
  systemPromptRole?: string;
}

interface AgentPlugin {
  agents: AgentProfile[];
}

// Self-description for the loader and the /plugins UI. An agent plugin is gated
// by enable only (no consent) — profiles are configuration data, not code.
export const manifest = {
  id: "example-agent",
  name: "Example Agent",
  kind: "agent" as const,
  description: "Demo agent plugin that adds a read-only `scout` sub-agent profile.",
};

// Profiles contributed by this plugin. Each entry is validated against the
// AgentProfileSchema at load time; malformed entries are skipped.
export const agentPlugin: AgentPlugin = {
  agents: [
    {
      id: "scout",
      description: "Fast read-only explorer — locates relevant code and returns citations",
      tier: "fast",
      capabilities: {
        mode: "allow",
        tools: ["read_file", "search_files", "grep", "list_dir"],
      },
      systemPromptRole:
        "You are a fast repository scout. You locate relevant code using read-only tools " +
        "and return compact file-path and line-range citations. You do not modify files.",
    },
  ],
};
