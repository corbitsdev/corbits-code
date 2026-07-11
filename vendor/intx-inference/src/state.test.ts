import { describe, test, expect } from "bun:test";

import { createStateManager } from "./state";

import type {
  AssistantTurn,
  PendingOperation,
  TokenUsage,
} from "@intx/types/runtime";
import type { GateSnapshot } from "./gates";

function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 };
}

function makeAssistantTurn(text: string): AssistantTurn {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    model: "mock-model",
    timestamp: 1000,
  };
}

function op(id: string): PendingOperation {
  return { correlationId: id, registeredAt: 1000, gateId: `g-${id}` };
}

function gate(id: string): GateSnapshot {
  return { gateId: id, type: "approval", timeoutAt: 5000 };
}

describe("createStateManager snapshot", () => {
  test("turns getter is lazy: reflects appends made after snapshot()", () => {
    const mgr = createStateManager("s", [], [], emptyUsage());
    const snap = mgr.snapshot();

    mgr.appendTurn(makeAssistantTurn("late"));

    expect(snap.turns).toHaveLength(1);
    expect(snap.turns[0]).toMatchObject({
      content: [{ type: "text", text: "late" }],
    });
  });

  test("turns getter is memoized: repeated reads return the same array", () => {
    const mgr = createStateManager(
      "s",
      [makeAssistantTurn("a")],
      [],
      emptyUsage(),
    );
    const snap = mgr.snapshot();

    expect(snap.turns).toBe(snap.turns);
  });

  test("turns is a copy with frozen elements (isolation)", () => {
    const mgr = createStateManager(
      "s",
      [makeAssistantTurn("a")],
      [],
      emptyUsage(),
    );
    const snap = mgr.snapshot();
    const view = snap.turns;

    view.push(makeAssistantTurn("mutant"));
    expect(mgr.getTurns()).toHaveLength(1);

    expect(Object.isFrozen(snap.turns[0])).toBe(true);
  });

  test("getTurns returns a copy: mutating it does not corrupt internal state", () => {
    const mgr = createStateManager(
      "s",
      [makeAssistantTurn("a")],
      [],
      emptyUsage(),
    );
    const turns = mgr.getTurns();
    turns.push(makeAssistantTurn("mutant"));
    expect(mgr.getTurns()).toHaveLength(1);
  });

  test("pendingOperations is point-in-time: later adds are not reflected", () => {
    const mgr = createStateManager("s", [], [op("one")], emptyUsage());
    const snap = mgr.snapshot();

    mgr.addPendingOperation(op("two"));

    expect(snap.pendingOperations).toHaveLength(1);
    expect(snap.pendingOperations[0]?.correlationId).toBe("one");
  });

  test("activeGates is point-in-time: later gate changes are not reflected", () => {
    const mgr = createStateManager("s", [], [], emptyUsage());
    mgr.setGatesSnapshot([gate("g1")]);
    const snap = mgr.snapshot();

    mgr.setGatesSnapshot([gate("g1"), gate("g2")]);

    expect(snap.activeGates).toHaveLength(1);
    expect(snap.activeGates[0]?.gateId).toBe("g1");
  });

  test("activeForks is point-in-time: later forks are not reflected", () => {
    const mgr = createStateManager("s", [], [], emptyUsage());
    mgr.addFork("f1", "child");
    const snap = mgr.snapshot();

    mgr.addFork("f2", "independent");

    expect(snap.activeForks).toHaveLength(1);
    expect(snap.activeForks[0]?.forkId).toBe("f1");
  });
});

describe("createStateManager turnsRevision", () => {
  test("advances on appendTurn and replaceTurns, not on reads", () => {
    const mgr = createStateManager("s", [], [], emptyUsage());
    expect(mgr.getTurnsRevision()).toBe(0);

    mgr.appendTurn(makeAssistantTurn("a"));
    expect(mgr.getTurnsRevision()).toBe(1);

    mgr.getTurns();
    mgr.snapshot().turns;
    expect(mgr.getTurnsRevision()).toBe(1);

    mgr.replaceTurns([makeAssistantTurn("b")]);
    expect(mgr.getTurnsRevision()).toBe(2);
  });
});
