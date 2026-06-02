import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { createTUIEventEmitter, getTUIRunSummaryStatus } from "../../../src/tui/runner.js";

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
