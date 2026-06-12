import { test, expect } from "bun:test";
import { createInjectionQueue, buildInjectionMessage } from "../../src/mid-run-inject.js";

test("createInjectionQueue enqueues and dequeues in FIFO order", () => {
  const queue = createInjectionQueue();
  queue.enqueue("first");
  queue.enqueue("second");
  expect(queue.size()).toBe(2);
  expect(queue.dequeue()).toBe("first");
  expect(queue.dequeue()).toBe("second");
  expect(queue.dequeue()).toBeUndefined();
  expect(queue.size()).toBe(0);
});

test("createInjectionQueue peek does not consume the item", () => {
  const queue = createInjectionQueue();
  queue.enqueue("hello");
  expect(queue.peek()).toBe("hello");
  expect(queue.size()).toBe(1);
  expect(queue.peek()).toBe("hello");
});

test("buildInjectionMessage contains the USER INTERRUPTION marker", () => {
  const msg = buildInjectionMessage("stop and fix the test first");
  expect(msg.content).toContain("[USER INTERRUPTION]");
  expect(msg.content).toContain("stop and fix the test first");
});

test("buildInjectionMessage instructs the model to assess and incorporate", () => {
  const msg = buildInjectionMessage("use tabs not spaces");
  expect(msg.content).toContain("course-correction");
  expect(msg.content).toContain("nudge");
});

// Simulate the mid-run delivery timing: a message typed during a run must be
// delivered after inference.done, not during a streaming turn.
test("queued message is only consumed at inference.done, not before", () => {
  const queue = createInjectionQueue();
  const delivered: string[] = [];

  // Simulate the runner.tsx emitter listener pattern.
  const drainOnInferenceDone = (eventType: string) => {
    if (eventType !== "inference.done") return;
    const text = queue.dequeue();
    if (text !== undefined) delivered.push(text);
  };

  queue.enqueue("please add error handling");

  // Simulate a sequence of streaming events — message must NOT be consumed.
  drainOnInferenceDone("inference.text.delta");
  drainOnInferenceDone("inference.tool_call.start");
  drainOnInferenceDone("tool.done");
  expect(delivered).toHaveLength(0);

  // Only after inference.done should the message be consumed.
  drainOnInferenceDone("inference.done");
  expect(delivered).toEqual(["please add error handling"]);
});
