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