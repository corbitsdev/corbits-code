// Agent profile contract. External profiles are data (JSON/YAML under
// .agents/agents/ or contributed by agent-kind plugins) validated against
// this shape at load time; these types never cross the repo boundary.

// Reasoning-effort levels carried through to the provider. The canonical
// definition lives here; src/provider/reasoning-effort.ts mirrors it as the
// runtime array. Ordered from least to most effort; "ultra" is not simply a
// bigger thinking budget than "max" — it additionally enables automatic
// sub-task delegation, so code that treats effort as a scalar dial may need
// to branch on it separately.
export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export type CapabilityMode = "exclude" | "allow";

export interface CapabilityFilter {
  mode: CapabilityMode;
  tools: string[];
}

// A single provider/model/effort combo an agent can run on, so an agent can
// pin "Sonnet + medium" or "Grok + high".
export interface InferenceLeg {
  provider: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
}

// Per-agent model selection spec, evaluated at dispatch time against the user's
// configured providers. `mode: "pin"` requires one of the legs to be available
// (else error / fallback per settings.agentModelFallback); `mode: "prefer"`
// (default) walks the chain and falls back if none are viable.
export interface InferenceSpec {
  mode?: "pin" | "prefer";
  order: InferenceLeg[];
}

export interface AgentProfile {
  // Unique identifier, used in workflow steps as `agent: "greybeard"`.
  id: string;
  description?: string;
  // Explicit per-agent model selection. When absent, the agent runs on the
  // parent session's active provider/model. See InferenceSpec for
  // resolution rules.
  inference?: InferenceSpec;
  // Optional tool restriction. Controls which tools the sub-agent can call.
  capabilities?: CapabilityFilter;
  // Appended to the sub-agent's base system prompt to specialize its behavior.
  systemPromptRole?: string;
  // Relative path to a markdown file whose content is loaded as systemPromptRole
  // at startup. Resolved relative to the profile source: the plugin directory for
  // plugin-contributed profiles, or .agents/agents/ for local profiles. When both
  // systemPromptRole and systemPromptPath are set, systemPromptRole wins.
  systemPromptPath?: string;
  // Orchestrator agents are an explicit exception to the "sub-agents do not
  // recurse" rule. When true, the dispatch-time appendix grants this profile
  // permission to call `task` to spawn other agents. Reserved for top-level
  // coordinators (e.g. a planning agent that fans work out to specialists);
  // leaf-task agents should leave this unset.
  orchestrator?: boolean;
  // Where the profile came from, for search_agents labeling (e.g. "claude",
  // "plugin:<id>", "local"). Omitted for built-in defaults.
  source?: string;
}

// The shape an agent-kind plugin contributes: a list of profiles.
export interface AgentPlugin {
  agents: AgentProfile[];
}
