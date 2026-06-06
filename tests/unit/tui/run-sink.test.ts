import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { createRunSink, getTUIRunSummaryStatus } from "../../../src/tui/run-sink.js";

function makeArgs() {
  const emitter = new EventEmitter();
  const hookManager = {
    dispatchPostTurn: (_ctx: unknown) => {},
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
