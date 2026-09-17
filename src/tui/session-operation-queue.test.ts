import { test, expect } from "bun:test";
import { createSessionOperationQueue } from "./delivery-queue.js";

async function expectSettlesSoon(
  promise: Promise<unknown>,
  label: string,
  ms = 250,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} did not settle within ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

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

  await flushMicrotasks();
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

test("abortInFlight unblocks a hung preemptible op so the next serial op can run", async () => {
  const log: string[] = [];
  const { enqueue, enqueuePreemptible, abortInFlight, awaitTail } =
    createSessionOperationQueue();

  enqueuePreemptible(async () => {
    log.push("preempt:start");
    await new Promise<void>(() => undefined);
  });
  enqueue(async () => {
    log.push("serial");
  });

  await flushMicrotasks();
  expect(log).toEqual(["preempt:start"]);

  abortInFlight();
  await expectSettlesSoon(awaitTail(), "awaitTail after abortInFlight");
  expect(log).toEqual(["preempt:start", "serial"]);
});

test("abortInFlight does not abort a serial op", async () => {
  const log: string[] = [];
  let resolveSerial: () => void = () => undefined;
  const gate = new Promise<void>((r) => (resolveSerial = r));
  const { enqueue, abortInFlight, awaitTail } = createSessionOperationQueue();

  enqueue(async () => {
    log.push("serial:start");
    await gate;
    log.push("serial:end");
  });
  enqueue(async () => {
    log.push("next");
  });

  await flushMicrotasks();
  abortInFlight();
  await flushMicrotasks();
  expect(log).toEqual(["serial:start"]);

  resolveSerial();
  await awaitTail();
  expect(log).toEqual(["serial:start", "serial:end", "next"]);
});

test("abandoned preemptible op resolving later does not run the next op twice", async () => {
  const log: string[] = [];
  let resolveHung: () => void = () => undefined;
  const hung = new Promise<void>((r) => (resolveHung = r));
  const { enqueue, enqueuePreemptible, abortInFlight, awaitTail } =
    createSessionOperationQueue();

  enqueuePreemptible(async () => {
    log.push("preempt:start");
    await hung;
    log.push("preempt:end");
  });
  enqueue(async () => {
    log.push("serial");
  });

  await flushMicrotasks();
  abortInFlight();
  await expectSettlesSoon(awaitTail(), "awaitTail after abortInFlight");
  expect(log).toEqual(["preempt:start", "serial"]);

  resolveHung();
  await flushMicrotasks();
  await awaitTail();
  expect(log.filter((entry) => entry === "serial")).toHaveLength(1);
  expect(log).toEqual(["preempt:start", "serial", "preempt:end"]);
});

test("a failed preemptible op does not block the tail", async () => {
  const log: string[] = [];
  const { enqueue, enqueuePreemptible, awaitTail } =
    createSessionOperationQueue();

  enqueuePreemptible(async () => {
    log.push("preempt");
    throw new Error("deliver failed");
  });
  enqueue(async () => {
    log.push("serial");
  });

  await awaitTail();
  expect(log).toEqual(["preempt", "serial"]);
});
