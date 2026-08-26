import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import type { ReactorEmittedEvent } from "@intx/inference";
import { createRunSink } from "./run-sink.js";
import type { LifecycleHookStatus } from "./hooks.js";
import { createTurnObserver } from "../telemetry/ai-observability.js";
import type { Telemetry } from "../telemetry/index.js";

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

function attributionHarness(selectedSource = { provider: "provider-a", model: "model-a" }) {
  const captured: { event: string; properties: Record<string, unknown> }[] = [];
  const telemetry: Telemetry = {
    enabled: true,
    installationId: "test",
    capture: (capturedEvent, properties = {}) => {
      captured.push({ event: capturedEvent, properties });
    },
    captureIntentional: () => false,
    flush: async () => {},
    discard: () => {},
  };
  const observer = createTurnObserver({
    telemetry: () => telemetry,
    getSessionId: () => "session-1",
    getSource: () => selectedSource,
  });
  const runSink = createRunSink({
    emitter: new EventEmitter(),
    hookManager: stubHookManager([]),
    ...observer,
  });
  return { captured, runSink };
}

function failMessageRun(runSink: ReturnType<typeof createRunSink>): void {
  runSink.sink(event("inference.error", { error: { message: "attempt failed" } }));
  runSink.sink(
    event("message.run.ended", {
      messageRunId: "run-1",
      messageId: "message-1",
      status: "failed",
    }),
  );
}

describe("createRunSink", () => {
  test("allocates no turn collector when no lifecycle hooks are configured", () => {
    const runSink = createRunSink({
      emitter: new EventEmitter(),
      hookManager: stubHookManager([]),
    });

    expect(runSink.getTurnCollector()).toBeNull();

    runSink.sink(
      event("inference.done", {
        turn: { role: "assistant", content: [], model: "test", timestamp: 0 },
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, thinking: 0 },
        source: { provider: "test", model: "test" },
      }),
    );

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

    runSink.sink(
      event("inference.done", {
        turn: { role: "assistant", content: [], model: "test", timestamp: 0 },
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, thinking: 0 },
        source: { provider: "test", model: "test" },
      }),
    );

    expect(runSink.getTurnCount()).toBe(1);
    expect(runSink.getTokenUsage()).toEqual({
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      thinking: 0,
    });
  });

  test("onTurnBoundarySnapshot reads getTurnCount after the turn, not the initial zero", () => {
    // Exec persist now snapshots from this callback (same as TUI). A closed-over
    // turnsUsed: 0 would write run.json as still-zero mid-run.
    const snapshots: number[] = [];
    const runSink = createRunSink({
      emitter: new EventEmitter(),
      hookManager: stubHookManager([]),
      onTurnBoundarySnapshot: () => {
        snapshots.push(runSink.getTurnCount());
      },
    });

    expect(runSink.getTurnCount()).toBe(0);
    runSink.sink(
      event("inference.done", {
        turn: { role: "assistant", content: [], model: "test", timestamp: 0 },
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, thinking: 0 },
        source: { provider: "test", model: "test" },
      }),
    );

    expect(snapshots).toEqual([1]);
    expect(runSink.getTurnCount()).toBe(1);
  });

  test("settles a pending inference failure only when the message run fails", () => {
    const failures: { turnIndex: number; error: string }[] = [];
    const runSink = createRunSink({
      emitter: new EventEmitter(),
      hookManager: stubHookManager([]),
      onTurnFailed: (info) => failures.push(info),
    });

    runSink.sink(event("inference.start", {}));
    runSink.sink(event("inference.error", { error: { message: "429 rate limit" } }));
    expect(failures).toEqual([]);

    runSink.sink(
      event("message.run.ended", {
        messageRunId: "run-1",
        messageId: "message-1",
        status: "failed",
        error: { message: "reactor gave up", kind: "inference_error" },
      }),
    );

    expect(failures).toEqual([{ turnIndex: 0, error: "429 rate limit" }]);
  });

  test("uses unknown attribution when a fallback model fails before usage", () => {
    const { captured, runSink } = attributionHarness();

    runSink.sink(event("inference.start", { model: "model-b" }));
    failMessageRun(runSink);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.event).toBe("$ai_generation");
    expect(captured[0]?.properties).toMatchObject({
      $ai_provider: "unknown",
      $ai_model: "model-b",
      $ai_is_error: true,
    });
  });

  test("uses the selected source when its model fails before usage", () => {
    const { captured, runSink } = attributionHarness();

    runSink.sink(event("inference.start", { model: "model-a" }));
    failMessageRun(runSink);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.properties).toMatchObject({
      $ai_provider: "provider-a",
      $ai_model: "model-a",
      $ai_is_error: true,
    });
  });

  test("uses authoritative usage attribution for a failed fallback", () => {
    const { captured, runSink } = attributionHarness();

    runSink.sink(event("inference.start", { model: "model-b" }));
    runSink.sink(
      event("inference.usage", {
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
        source: { sourceId: "fallback", provider: "provider-b", model: "model-b" },
      }),
    );
    failMessageRun(runSink);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.properties).toMatchObject({
      $ai_provider: "provider-b",
      $ai_model: "model-b",
      $ai_is_error: true,
    });
  });

  test("does not leak authoritative source attribution across retry attempts", () => {
    const { captured, runSink } = attributionHarness();

    runSink.sink(event("inference.start", { model: "model-a" }));
    runSink.sink(
      event("inference.usage", {
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
        source: { sourceId: "selected", provider: "provider-a", model: "model-a" },
      }),
    );
    runSink.sink(event("inference.error", { error: { message: "retry" } }));
    runSink.sink(event("inference.start", { model: "model-b" }));
    failMessageRun(runSink);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.properties).toMatchObject({
      $ai_provider: "unknown",
      $ai_model: "model-b",
      $ai_is_error: true,
    });
  });

  test("discards a recoverable inference failure after retry success", () => {
    const failures: { turnIndex: number; error: string }[] = [];
    const completions: number[] = [];
    const runSink = createRunSink({
      emitter: new EventEmitter(),
      hookManager: stubHookManager([]),
      onTurnComplete: (ctx) => completions.push(ctx.turnIndex),
      onTurnFailed: (info) => failures.push(info),
    });

    runSink.sink(event("inference.start", {}));
    runSink.sink(event("inference.error", { error: { message: "retry me" } }));
    runSink.sink(event("inference.start", {}));
    runSink.sink(
      event("inference.done", {
        turn: { role: "assistant", content: [], model: "test", timestamp: 0 },
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, thinking: 0 },
        source: { provider: "test", model: "test" },
      }),
    );
    runSink.sink(
      event("message.run.ended", {
        messageRunId: "run-1",
        messageId: "message-1",
        status: "completed",
      }),
    );

    expect(completions).toEqual([0]);
    expect(failures).toEqual([]);
  });

  test("reports no failure for a turn that already completed", () => {
    const failures: { turnIndex: number; error: string }[] = [];
    const completions: number[] = [];
    const runSink = createRunSink({
      emitter: new EventEmitter(),
      hookManager: stubHookManager([]),
      onTurnComplete: (ctx) => completions.push(ctx.turnIndex),
      onTurnFailed: (info) => failures.push(info),
    });

    runSink.sink(event("inference.start", {}));
    runSink.sink(
      event("inference.done", {
        turn: { role: "assistant", content: [], model: "test", timestamp: 0 },
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, thinking: 0 },
        source: { provider: "test", model: "test" },
      }),
    );
    runSink.sink(event("reactor.error", { error: "reactor gave up at shutdown" }));

    expect(completions).toEqual([0]);
    expect(failures).toEqual([]);
  });

  test("settles the latest failed retry exactly once", () => {
    const failures: { turnIndex: number; error: string }[] = [];
    const runSink = createRunSink({
      emitter: new EventEmitter(),
      hookManager: stubHookManager([]),
      onTurnFailed: (info) => failures.push(info),
    });

    runSink.sink(event("inference.start", {}));
    runSink.sink(event("inference.error", { error: { message: "500 upstream" } }));
    runSink.sink(event("inference.start", {}));
    runSink.sink(event("inference.error", { error: { message: "500 upstream again" } }));
    runSink.sink(
      event("message.run.ended", {
        messageRunId: "run-1",
        messageId: "message-1",
        status: "failed",
      }),
    );

    expect(failures).toEqual([{ turnIndex: 0, error: "500 upstream again" }]);
  });

  test("reset discards an unresolved pending failure", () => {
    const failures: { turnIndex: number; error: string }[] = [];
    const runSink = createRunSink({
      emitter: new EventEmitter(),
      hookManager: stubHookManager([]),
      onTurnFailed: (info) => failures.push(info),
    });

    runSink.sink(event("inference.start", {}));
    runSink.sink(event("inference.error", { error: { message: "first session" } }));
    runSink.reset();
    runSink.sink(event("inference.start", {}));
    runSink.sink(event("inference.error", { error: { message: "second session" } }));
    runSink.sink(
      event("message.run.ended", {
        messageRunId: "run-2",
        messageId: "message-2",
        status: "failed",
      }),
    );

    expect(failures).toEqual([{ turnIndex: 0, error: "second session" }]);
  });

  test("seeds the turn count from a resumed session's prior turnsUsed", () => {
    const runSink = createRunSink({
      emitter: new EventEmitter(),
      hookManager: stubHookManager([]),
      initialTurnCount: 7,
    });

    expect(runSink.getTurnCount()).toBe(7);

    runSink.sink(
      event("inference.done", {
        turn: { role: "assistant", content: [], model: "test", timestamp: 0 },
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, thinking: 0 },
        source: { provider: "test", model: "test" },
      }),
    );

    expect(runSink.getTurnCount()).toBe(8);
  });

  test("getLastTurnUsage reports the latest turn alone, not the running sum", () => {
    const runSink = createRunSink({
      emitter: new EventEmitter(),
      hookManager: stubHookManager([]),
    });

    runSink.sink(
      event("inference.done", {
        turn: { role: "assistant", content: [], model: "test", timestamp: 0 },
        usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, thinking: 0 },
        source: { provider: "test", model: "test" },
      }),
    );
    runSink.sink(
      event("inference.done", {
        turn: { role: "assistant", content: [], model: "test", timestamp: 0 },
        usage: { input: 150, output: 20, cacheRead: 5, cacheWrite: 0, thinking: 0 },
        source: { provider: "test", model: "test" },
      }),
    );

    expect(runSink.getTokenUsage()).toEqual({
      input: 250,
      output: 30,
      cacheRead: 5,
      cacheWrite: 0,
      thinking: 0,
    });
    expect(runSink.getLastTurnUsage()).toEqual({
      input: 150,
      output: 20,
      cacheRead: 5,
      cacheWrite: 0,
      thinking: 0,
    });
  });

  // Regression: exec finish metrics must not dereference getTurnCollector()
  // when hooks are absent — that path returns null and crashed evals with
  // "null is not an object (evaluating 'turnCollector.getTurnCount')".
  test("hookless finish metrics are readable via runSink methods alone", () => {
    const runSink = createRunSink({
      emitter: new EventEmitter(),
      hookManager: stubHookManager([]),
    });

    runSink.sink(
      event("inference.done", {
        turn: { role: "assistant", content: [], model: "test", timestamp: 0 },
        usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, thinking: 0 },
        source: { provider: "test", model: "test" },
      }),
    );

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
