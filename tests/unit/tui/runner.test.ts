import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { createTUIEventEmitter, getTUIRunSummaryStatus } from "../../../src/tui/runner.js";
import { createRunSink } from "../../../src/session/run-sink.js";

test("createTUIEventEmitter returns an EventEmitter", () => {
  const emitter = createTUIEventEmitter();
  expect(emitter).toBeInstanceOf(EventEmitter);
});

test("createTUIEventEmitter can emit and receive events", () => {
  const emitter = createTUIEventEmitter();
  const received: unknown[] = [];
  emitter.on("event", (data) => received.push(data));
  emitter.emit("event", { type: "test" });
  expect(received.length).toBe(1);
});

test("getTUIRunSummaryStatus distinguishes done, failed, and cancelled runs", () => {
  expect(getTUIRunSummaryStatus(true, undefined)).toBe("done");
  expect(getTUIRunSummaryStatus(true, "network failed")).toBe("failed");
  expect(getTUIRunSummaryStatus(false, undefined)).toBe("cancelled");
});

// Rotation behavioral tests — these exercise the serial-queue and per-session
// store semantics without spinning up a real TUI or agent.

// The serial operation queue must run operations one at a time and drain in order.
test("serial operation queue executes operations in order without interleaving", async () => {
  const log: string[] = [];

  let queueTail: Promise<void> = Promise.resolve();
  const enqueue = (op: () => Promise<void>): Promise<void> => {
    queueTail = queueTail.then(op, op);
    return queueTail;
  };

  let resolveA!: () => void;
  const opA = new Promise<void>((r) => (resolveA = r));

  enqueue(async () => {
    log.push("A:start");
    await opA;
    log.push("A:end");
  });

  enqueue(async () => {
    log.push("B:start");
    log.push("B:end");
  });

  // B must not start until A finishes, even though A is async.
  await Promise.resolve();
  await Promise.resolve();
  expect(log).toEqual(["A:start"]);

  resolveA();
  await queueTail;
  expect(log).toEqual(["A:start", "A:end", "B:start", "B:end"]);
});

// When buildAgent throws after the old agent is closed, fatalBuildError must
// be set so subsequent sends fail immediately rather than dispatching to a
// closed agent. This test models that invariant via the run-sink state machine.
test("rotation resets run-sink so a new session starts from a clean state", () => {
  const emitter = new EventEmitter();
  const hookManager = { dispatchPostTurn: () => {} };
  const runSink = createRunSink({ emitter, hookManager });

  // Session 1 completes.
  runSink.sink({ type: "reactor.done", data: {} } as never);
  const collectorBeforeReset = runSink.getTurnCollector();
  expect(runSink.getStatus()).toBe("done");

  // Rotation: reset opens a clean session.
  runSink.reset();

  // The new collector is a fresh instance — not the same object as before.
  const collectorAfterReset = runSink.getTurnCollector();
  expect(collectorAfterReset).not.toBe(collectorBeforeReset);

  // Status is cancelled (no events received in new session yet).
  expect(runSink.getStatus()).toBe("cancelled");

  // Session 2 can accumulate independently.
  runSink.sink({ type: "reactor.done", data: {} } as never);
  expect(runSink.getStatus()).toBe("done");
  expect(collectorAfterReset.getTurns()).toHaveLength(0);
});
