// Reactor state management: turn history, async operations, usage tracking.
//
// The state object is the authoritative view the director receives on every
// decision. It is mutable by the reactor only — the director receives a
// snapshot so it cannot corrupt the reactor's internal state.
//
// (INFERENCE.md § Agent Reactor › Director Decision Function)

import type {
  ConversationTurn,
  LastCycleSource,
  PendingOperation,
  TokenUsage,
  ReactorState,
} from "@intx/types/runtime";
import type { GateSnapshot } from "./gates";

export type ReactorStateManager = ReturnType<typeof createStateManager>;

/**
 * Recursively freezes a turn so snapshots can share its reference instead of
 * deep-cloning the whole history on every director decision. Freezing costs
 * O(turn size) once at append; cloning cost O(total history) per snapshot.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

/**
 * Creates a mutable state container. All mutations go through explicit methods;
 * the `snapshot()` method produces an immutable view for the director.
 */
export function createStateManager(
  sessionId: string,
  initialTurns: ConversationTurn[],
  initialOps: PendingOperation[],
  initialUsage: TokenUsage,
) {
  let turns: ConversationTurn[] = initialTurns.map(deepFreeze);
  // Monotonic counter bumped whenever `turns` changes. Persistence compares it
  // against the revision it last wrote so an unchanged history is never
  // re-serialized on a checkpoint (INFERENCE.md § Cycle boundary commit).
  let turnsRevision = 0;
  const pendingOperations = new Map<string, PendingOperation>(
    initialOps.map((op) => [op.correlationId, op]),
  );
  const tokenUsage: TokenUsage = { ...initialUsage };
  let lastCycleUsage: TokenUsage | null = null;
  let lastCycleSource: LastCycleSource | null = null;
  let activeGatesSnapshot: GateSnapshot[] = [];
  const activeForks: { forkId: string; mode: "independent" | "child" }[] = [];

  function appendTurn(msg: ConversationTurn): void {
    turns.push(deepFreeze(msg));
    turnsRevision += 1;
  }

  function replaceTurns(next: ConversationTurn[]): void {
    turns = next.map(deepFreeze);
    turnsRevision += 1;
  }

  function addPendingOperation(op: PendingOperation): void {
    pendingOperations.set(op.correlationId, op);
  }

  function removePendingOperation(correlationId: string): void {
    pendingOperations.delete(correlationId);
  }

  function accumUsage(usage: TokenUsage): void {
    tokenUsage.input += usage.input;
    tokenUsage.output += usage.output;
    tokenUsage.cacheRead += usage.cacheRead;
    tokenUsage.cacheWrite += usage.cacheWrite;
    tokenUsage.thinking += usage.thinking;
  }

  function setLastCycleUsage(usage: TokenUsage): void {
    lastCycleUsage = { ...usage };
  }

  function setLastCycleSource(source: LastCycleSource): void {
    lastCycleSource = { ...source };
  }

  function setGatesSnapshot(gates: GateSnapshot[]): void {
    activeGatesSnapshot = gates;
  }

  function addFork(forkId: string, mode: "independent" | "child"): void {
    activeForks.push({ forkId, mode });
  }

  function removeFork(forkId: string): void {
    const idx = activeForks.findIndex((f) => f.forkId === forkId);
    if (idx !== -1) activeForks.splice(idx, 1);
  }

  function getTurns(): ConversationTurn[] {
    return turns;
  }

  function getTurnsRevision(): number {
    return turnsRevision;
  }

  function getPendingOperations(): PendingOperation[] {
    return Array.from(pendingOperations.values());
  }

  function getTokenUsage(): TokenUsage {
    return { ...tokenUsage };
  }

  function snapshot(): ReactorState {
    // Every field is a lazy, memoized getter. High-frequency events (tool.done,
    // inference.error) reach directors that never inspect `turns`, so paying an
    // O(history) copy on every decision made per-event cost scale with session
    // length. Deferring each field's copy to first access keeps read-only
    // decisions O(fields they actually read) while preserving isolation: turns
    // are deep-frozen at append, and every derived collection is a fresh copy.
    let turnsView: ConversationTurn[] | undefined;
    let pendingView: PendingOperation[] | undefined;
    let gatesView: ReactorState["activeGates"] | undefined;
    let forksView: ReactorState["activeForks"] | undefined;
    return {
      sessionId,
      get turns() {
        return (turnsView ??= turns.slice());
      },
      get pendingOperations() {
        return (pendingView ??= Array.from(pendingOperations.values()).map(
          (op) => ({ ...op }),
        ));
      },
      get activeGates() {
        return (gatesView ??= activeGatesSnapshot.map((g) => ({
          gateId: g.gateId,
          type: g.type,
          timeoutAt: g.timeoutAt,
        })));
      },
      get activeForks() {
        return (forksView ??= activeForks.map((f) => ({ ...f })));
      },
      tokenUsage: { ...tokenUsage },
      lastCycleUsage: lastCycleUsage !== null ? { ...lastCycleUsage } : null,
      lastCycleSource: lastCycleSource !== null ? { ...lastCycleSource } : null,
    };
  }

  return {
    appendTurn,
    replaceTurns,
    addPendingOperation,
    removePendingOperation,
    accumUsage,
    setLastCycleUsage,
    setLastCycleSource,
    setGatesSnapshot,
    addFork,
    removeFork,
    getTurns,
    getTurnsRevision,
    getPendingOperations,
    getTokenUsage,
    snapshot,
  };
}
