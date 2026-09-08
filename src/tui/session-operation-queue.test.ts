import { test, expect } from "bun:test";
import { createSessionOperationQueue } from "./session-operation-queue.js";

test("serial operation queue executes operations in order without interleaving", async () => {
  const log: string[] = [];
  const { enqueue, awaitTail } = createSessionOperationQueue();

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

test("rotation enqueued during an in-flight delivery waits for it to settle", async () => {
  const log: string[] = [];
  const { enqueue, awaitTail } = createSessionOperationQueue();

  let resolveSend!: () => void;
  const send = new Promise<void>((r) => (resolveSend = r));

  enqueue(async () => {
    log.push("deliver:start");
    await send;
    log.push("deliver:end");
  });
  enqueue(async () => {
    log.push("rotate:start");
    log.push("rotate:end");
  });

  // The rotation is already queued while the delivery is still awaiting the
  // provider send — it must not start (rotating the session dir) mid-delivery.
  await Promise.resolve();
  await Promise.resolve();
  expect(log).toEqual(["deliver:start"]);

  resolveSend();
  await awaitTail();
  expect(log).toEqual(["deliver:start", "deliver:end", "rotate:start", "rotate:end"]);
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
