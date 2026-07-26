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
});
