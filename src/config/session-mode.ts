import type { LocalSettings, Settings } from "./settings.js";

export type SessionMode = "single" | "orchestrator";

export const SESSION_MODES: readonly SessionMode[] = ["single", "orchestrator"];

export function isSessionMode(value: unknown): value is SessionMode {
  return value === "single" || value === "orchestrator";
}

// Per-repo local selection wins over the global default in ~/.intercode/settings.json.
export function resolveSessionMode(
  global: Settings | null | undefined,
  local: LocalSettings | null | undefined,
): SessionMode | undefined {
  if (local?.sessionMode !== undefined) return local.sessionMode;
  return global?.sessionMode;
}

export function sessionModeEnablesSubAgents(mode: SessionMode): boolean {
  return mode === "orchestrator";
}