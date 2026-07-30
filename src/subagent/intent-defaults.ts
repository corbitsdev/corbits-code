import type { CapabilityFilter } from "../agent/profile-types.js";
import type { ProviderTier } from "../config/settings.js";

/** Typed spawn intent — optional on `task`; omit Intent section when unset. */
export type TaskIntent = "explore" | "implement" | "review" | "plan" | "general";

/**
 * Soft defaults applied when task(intent=…) is set and the parent/profile
 * omit the corresponding hard field. Precedence is owned by createTaskTool:
 * task arg > profile > intent > settings/parent.
 */

/** Write tools denied for recon intents (explore / review / plan). */
export const INTENT_WRITE_TOOLS = ["write_file", "edit_file", "delete_file"] as const;

export type IntentDefaults = {
  /** Tool filter when profile.capabilities is unset and leaf is not orchestrator. */
  capabilities?: CapabilityFilter;
  /** Soft tier hint; applied only when configured and no task/profile model. */
  tier?: ProviderTier;
  /** Turn budget when task and profile omit maxTurns. */
  maxTurns?: number;
};

const READ_ONLY_EXCLUDE: CapabilityFilter = {
  mode: "exclude",
  tools: [...INTENT_WRITE_TOOLS],
};

/**
 * Map spawn intent to soft tool / tier / maxTurns defaults.
 * Undefined or general → empty (current full-toolset / settings behavior).
 */
export function resolveIntentDefaults(intent: TaskIntent | undefined): IntentDefaults {
  switch (intent) {
    case "explore":
      return {
        capabilities: READ_ONLY_EXCLUDE,
        tier: "fast",
        maxTurns: 20,
      };
    case "review":
      return {
        capabilities: READ_ONLY_EXCLUDE,
        tier: "standard",
        maxTurns: 25,
      };
    case "plan":
      return {
        capabilities: READ_ONLY_EXCLUDE,
        tier: "clever",
        maxTurns: 25,
      };
    case "implement":
      return {
        maxTurns: 50,
      };
    case "general":
    case undefined:
      return {};
  }
}
