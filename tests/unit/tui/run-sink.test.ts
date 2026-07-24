import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { createRunSink, getTUIRunSummaryStatus } from "../../../src/session/run-sink.js";

function makeArgs() {
  const emitter = new EventEmitter();
  const hookManager = {
    dispatchPostTurn: (_ctx: unknown) => {},
    getStatuses: () => [
      { id: "h1", name: "log.ts", type: "typescript" as const, path: "/hooks/log.ts", enabled: true },
    ],
  };
  return { emitter, hookManager };
}

test("getTUIRunSummaryStatus distinguishes done, failed, and cancelled runs", () => {
  expect(getTUIRunSummaryStatus(true, undefined)).toBe("done");
  expect(getTUIRunSummaryStatus(true, "network failed")).toBe("failed");
  expect(getTUIRunSummaryStatus(false, undefined)).toBe("cancelled");
});

test("no events → getStatus returns cancelled", () => {
  const args = makeArgs();
  const runSink = createRunSink(args);
  expect(runSink.getStatus()).toBe("cancelled");
  expect(runSink.getRunError()).toBeUndefined();
});

test("reactor.done event → getStatus returns done", () => {
  const args = makeArgs();
  const runSink = createRunSink(args);
  runSink.sink({ type: "reactor.done", data: {} } as never);
  expect(runSink.getStatus()).toBe("done");
  expect(runSink.getRunError()).toBeUndefined();
});

test("reactor.error event → getStatus returns failed with error", () => {
  const args = makeArgs();
  const runSink = createRunSink(args);
  runSink.sink({ type: "reactor.error", data: { error: "reactor blew up" } } as never);
  expect(runSink.getStatus()).toBe("failed");
  expect(runSink.getRunError()).toBe("reactor blew up");
});

test("inference.error event → getStatus returns failed with message", () => {
  const args = makeArgs();
  const runSink = createRunSink(args);
  runSink.sink({ type: "inference.error", data: { error: { message: "inference failed" } } } as never);
  expect(runSink.getStatus()).toBe("failed");
  expect(runSink.getRunError()).toBe("inference failed");
});

test("sink forwards events via the emitter", () => {
  const args = makeArgs();
  const runSink = createRunSink(args);
  const received: unknown[] = [];
  args.emitter.on("event", (e) => received.push(e));
  const event = { type: "reactor.done", data: {} } as never;
  runSink.sink(event);
  expect(received.length).toBe(1);
  expect(received[0]).toBe(event);
});

test("getTurnCollector is available and has expected shape", () => {
  const args = makeArgs();
  const runSink = createRunSink(args);
  const collector = runSink.getTurnCollector();
  expect(typeof collector.observe).toBe("function");
  expect(typeof collector.getTurns).toBe("function");
  expect(typeof collector.getTokenUsage).toBe("function");
  expect(typeof collector.getToolCallCount).toBe("function");
});

// Session rotation: reset() clears accumulated state so the post-run hook for a
// new session only sees turns from that session, not the prior one.
test("reset clears status, error, and turn collector between sessions", () => {
  const args = makeArgs();
  const runSink = createRunSink(args);

  // Simulate a completed session with an error.
  runSink.sink({ type: "reactor.done", data: {} } as never);
  runSink.sink({ type: "reactor.error", data: { error: "oops" } } as never);
  expect(runSink.getStatus()).toBe("failed");
  expect(runSink.getRunError()).toBe("oops");

  // Rotate — new session begins.
  runSink.reset();

  // Status resets to cancelled (no events yet) and error is gone.
  expect(runSink.getStatus()).toBe("cancelled");
  expect(runSink.getRunError()).toBeUndefined();

  // The turn collector returned after reset is fresh.
  const collector = runSink.getTurnCollector();
  expect(collector.getTurns()).toHaveLength(0);
  expect(collector.getToolCallCount()).toBe(0);

  // New session can complete normally.
  runSink.sink({ type: "reactor.done", data: {} } as never);
  expect(runSink.getStatus()).toBe("done");
});

// onTurnComplete is telemetry's hook into turn completion, wired alongside
// (not instead of) the post-turn lifecycle hook — both must fire per turn.
test("onTurnComplete fires alongside dispatchPostTurn for each completed turn", () => {
  const emitter = new EventEmitter();
  const dispatched: unknown[] = [];
  const completed: unknown[] = [];
  const hookManager = {
    dispatchPostTurn: (ctx: unknown) => {
      dispatched.push(ctx);
    },
    getStatuses: () => [],
  };
  const runSink = createRunSink({
    emitter,
    hookManager,
    onTurnComplete: (ctx) => {
      completed.push(ctx);
    },
  });

  runSink.sink({
    type: "inference.done",
    data: {
      turn: { content: [] },
      usage: {},
      source: "primary",
    },
  } as never);

  expect(dispatched.length).toBe(1);
  expect(completed.length).toBe(1);
  expect(dispatched[0]).toBe(completed[0]);
});
