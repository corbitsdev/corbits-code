import type { LocalSettings, Settings } from "./settings.js";

/**
 * Orchestrator is the only product path. The type is retained as a single
 * literal so call sites can drop the parameter without a big-bang rename;
 * `"single"` is never returned from resolve helpers.
 */
export type SessionMode = "orchestrator";

/**
 * Product always runs orchestrator. Legacy `sessionMode` values in settings
 * (including `"single"`) are ignored — not errors on load, not written back.
 */
export function resolveSessionMode(
  _global?: Settings | null,
  _local?: LocalSettings | null,
): SessionMode {
  return "orchestrator";
}

/** Sub-agents are always available on the primary session. */
export function sessionModeEnablesSubAgents(_mode?: SessionMode): boolean {
  return true;
}
