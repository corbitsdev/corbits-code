import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import type { ReactorEmittedEvent } from "@intx/inference";
import { createRunSink } from "./run-sink.js";
import type { LifecycleHookStatus } from "./hooks.js";

function event(type: string, data: unknown): ReactorEmittedEvent {
  return { type, seq: 1, data } as ReactorEmittedEvent;
}

function stubHookManager(statuses: LifecycleHookStatus[]) {
  return {
    getStatuses: () => statuses,
    dispatchPostTurn: () => {},
  };
}

const enabledHook: LifecycleHookStatus = {
  id: "h1",
  name: "log.ts",
  type: "typescript",
  path: "/hooks/log.ts",
  enabled: true,
};

describe("createRunSink", () => {
  test("allocates no turn collector when no lifecycle hooks are configured", () => {
    const runSink = createRunSink({
      emitter: new EventEmitter(),
      hookManager: stubHookManager([]),
    });

    expect(runSink.getTurnCollector()).toBeNull();

    runSink.sink(event("inference.done", {
      turn: { role: "assistant", content: [], model: "test", timestamp: 0 },
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, thinking: 0 },
      source: { provider: "test", model: "test" },
    }));

    expect(runSink.getTurnCollector()).toBeNull();
  });

  test("stays without a collector after reset when still hookless", () => {
    const runSink = createRunSink({
      emitter: new EventEmitter(),
      hookManager: stubHookManager([]),
    });

    runSink.reset();

    expect(runSink.getTurnCollector()).toBeNull();
  });

  test("allocates a turn collector when a lifecycle hook is configured", () => {
    const runSink = createRunSink({
      emitter: new EventEmitter(),
      hookManager: stubHookManager([enabledHook]),
    });

    expect(runSink.getTurnCollector()).not.toBeNull();
  });

  test("still tracks an accurate turn count without a lifecycle hook configured", () => {
    const runSink = createRunSink({
      emitter: new EventEmitter(),
      hookManager: stubHookManager([]),
    });

    runSink.sink(event("inference.done", {
      turn: { role: "assistant", content: [], model: "test", timestamp: 0 },
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, thinking: 0 },
      source: { provider: "test", model: "test" },
    }));

    expect(runSink.getTurnCount()).toBe(1);
    expect(runSink.getTokenUsage()).toEqual({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, thinking: 0 });
  });

  test("seeds the turn count from a resumed session's prior turnsUsed", () => {
    const runSink = createRunSink({
      emitter: new EventEmitter(),
      hookManager: stubHookManager([]),
      initialTurnCount: 7,
    });

    expect(runSink.getTurnCount()).toBe(7);

    runSink.sink(event("inference.done", {
      turn: { role: "assistant", content: [], model: "test", timestamp: 0 },
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, thinking: 0 },
      source: { provider: "test", model: "test" },
    }));

    expect(runSink.getTurnCount()).toBe(8);
  });

  test("getLastTurnUsage reports the latest turn alone, not the running sum", () => {
    const runSink = createRunSink({
      emitter: new EventEmitter(),
      hookManager: stubHookManager([]),
    });

    runSink.sink(event("inference.done", {
      turn: { role: "assistant", content: [], model: "test", timestamp: 0 },
      usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, thinking: 0 },
      source: { provider: "test", model: "test" },
    }));
    runSink.sink(event("inference.done", {
      turn: { role: "assistant", content: [], model: "test", timestamp: 0 },
      usage: { input: 150, output: 20, cacheRead: 5, cacheWrite: 0, thinking: 0 },
      source: { provider: "test", model: "test" },
    }));

    expect(runSink.getTokenUsage()).toEqual({ input: 250, output: 30, cacheRead: 5, cacheWrite: 0, thinking: 0 });
    expect(runSink.getLastTurnUsage()).toEqual({ input: 150, output: 20, cacheRead: 5, cacheWrite: 0, thinking: 0 });
  });

  // Regression: exec finish metrics must not dereference getTurnCollector()
  // when hooks are absent — that path returns null and crashed evals with
  // "null is not an object (evaluating 'turnCollector.getTurnCount')".
  test("hookless finish metrics are readable via runSink methods alone", () => {
    const runSink = createRunSink({
      emitter: new EventEmitter(),
      hookManager: stubHookManager([]),
    });

    runSink.sink(event("inference.done", {
      turn: { role: "assistant", content: [], model: "test", timestamp: 0 },
      usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, thinking: 0 },
      source: { provider: "test", model: "test" },
    }));

    const turnCollector = runSink.getTurnCollector();
    expect(turnCollector).toBeNull();

    // Same shape exec/TUI use after a run ends.
    const finish = {
      turnsUsed: runSink.getTurnCount(),
      tokenUsage: runSink.getTokenUsage(),
      turns: turnCollector?.getTurns() ?? [],
      toolCallCount: runSink.getToolCallCount(),
    };

    expect(finish).toEqual({
      turnsUsed: 1,
      tokenUsage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, thinking: 0 },
      turns: [],
      toolCallCount: 0,
    });
  });
});
