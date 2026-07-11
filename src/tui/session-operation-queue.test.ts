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