/**
 * Process-wide open-turn id for nesting permission.wait/subagent spans outside
 * the reactor observer. One observer owns the slot; a second concurrent
 * observer overwrites it — unsupported. `clear()`, `reset()`, and `closeTurn`
 * null it.
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
