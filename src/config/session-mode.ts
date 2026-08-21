import type { LocalSettings, Settings } from "./settings.js";

/**
 * CL-5814: orchestrator is the only product path. The type is retained as a
 * single literal so call sites can drop the parameter without a big-bang rename
 * in the same PR series; `"single"` is never returned from resolve helpers.
 */
export type SessionMode = "orchestrator";

export const SESSION_MODES: readonly SessionMode[] = ["orchestrator"];

export function isSessionMode(value: unknown): value is SessionMode {
  return value === "orchestrator";
}

/**
 * Product always runs orchestrator. Legacy `sessionMode` values in settings
 * (including `"single"`) are ignored — not errors on load, not written back here.
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
