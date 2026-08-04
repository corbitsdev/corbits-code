/**
 * Process-wide open-turn id for nesting permission.wait / subagent outside the
 * reactor observer. Single-primary assumption: one run-sink observer owns the
 * slot. `clear()` and observer `reset()`/`closeTurn` null it.
 */

let activeTurnId: string | null = null;

export function getActiveTurnId(): string | null {
  return activeTurnId;
}

export function setActiveTurnId(id: string | null): void {
  activeTurnId = id;
}

export function clearActiveTurnId(): void {
  activeTurnId = null;
}
