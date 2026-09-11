import { test, expect } from "bun:test";
import { createSessionOperationQueue } from "./session-operation-queue.js";

test("serial operation queue executes operations in order without interleaving", async () => {
  const log: string[] = [];
  const { enqueue, awaitTail } = createSessionOperationQueue();

  let resolveA: () => void = () => undefined;
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

  await Promise.resolve();
  await Promise.resolve();
  expect(log).toEqual(["A:start"]);

  resolveA();
  await awaitTail();
  expect(log).toEqual(["A:start", "A:end", "B:start", "B:end"]);
});

test("deliver runs after rotation when rotation was enqueued first", async () => {
  const log: string[] = [];
  let agent: "A" | "B" = "A";
  const { enqueue, awaitTail } = createSessionOperationQueue();

  const enqueueDeliver = () =>
    enqueue(async () => {
      log.push(`deliver:${agent}`);
    });

  enqueue(async () => {
    log.push("rotate");
    agent = "B";
  });
  enqueueDeliver();
  await awaitTail();
  expect(log).toEqual(["rotate", "deliver:B"]);
});

test("deliver targets agent at execution time when enqueued before rotation", async () => {
  const log: string[] = [];
  let agent: "A" | "B" = "A";
  const { enqueue, awaitTail } = createSessionOperationQueue();

  enqueue(async () => {
    log.push(`deliver:${agent}`);
  });
  enqueue(async () => {
    log.push("rotate");
    agent = "B";
  });
  await awaitTail();
  expect(log).toEqual(["deliver:A", "rotate"]);
});

test("a failed delivery does not block a rotation queued behind it", async () => {
  const log: string[] = [];
  const { enqueue, awaitTail } = createSessionOperationQueue();

  enqueue(async () => {
    log.push("deliver:start");
    throw new Error("send failed");
  });
  enqueue(async () => {
    log.push("rotate");
  });

  await awaitTail();
  expect(log).toEqual(["deliver:start", "rotate"]);
});

test("awaitTail from inside the current op settles instead of deadlocking", async () => {
  const log: string[] = [];
  const { enqueue, awaitTail } = createSessionOperationQueue();

  enqueue(async () => {
    log.push("start");
    await awaitTail();
    log.push("after-tail");
  });
  await awaitTail();
  expect(log).toEqual(["start", "after-tail"]);
});

test("awaitTail from outside still waits for the current op", async () => {
  const log: string[] = [];
  const { enqueue, awaitTail } = createSessionOperationQueue();
  let resolveSlow: () => void = () => undefined;
  const slow = new Promise<void>((r) => {
    resolveSlow = r;
  });

  enqueue(async () => {
    log.push("start");
    await slow;
    log.push("end");
  });
  const outside = awaitTail().then(() => {
    log.push("outside");
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(log).toEqual(["start"]);
  resolveSlow();
  await outside;
  expect(log).toEqual(["start", "end", "outside"]);
});
