import { expect, spyOn, test } from "bun:test";
import { getLogger } from "@intx/log";

import { LOG_NAMESPACE_ROOT } from "../branding.js";
import {
  createSessionOperationQueue,
  SessionOperationSelfWaitError,
} from "./delivery-queue.js";

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

test("awaiting enqueue from inside the running op rejects and a later op still runs", async () => {
  const log: string[] = [];
  const warn = spyOn(getLogger([LOG_NAMESPACE_ROOT, "tui"]), "warn");
  const { enqueue, awaitTail } = createSessionOperationQueue();

  const running = enqueue(async () => {
    log.push("outer");
    try {
      await enqueue(async () => {
        log.push("inner");
      });
    } finally {
      void enqueue(async () => {
        log.push("later");
      });
    }
  });

  await expect(running).rejects.toBeInstanceOf(SessionOperationSelfWaitError);
  await expect(running).rejects.toThrow(
    "waited on work it queued behind itself",
  );
  await awaitTail();
  expect(log).toEqual(["outer", "inner", "later"]);
  expect(warn).toHaveBeenCalledTimes(1);
  warn.mockRestore();
});

test("awaiting awaitTail from inside the running op rejects and the queue still drains", async () => {
  const log: string[] = [];
  const { enqueue, awaitTail } = createSessionOperationQueue();

  const running = enqueue(async () => {
    log.push("outer");
    try {
      await awaitTail();
    } finally {
      void enqueue(async () => {
        log.push("later");
      });
    }
  });

  await expect(running).rejects.toBeInstanceOf(SessionOperationSelfWaitError);
  await awaitTail();
  expect(log).toEqual(["outer", "later"]);
});

test("awaiting enqueue after the running op has suspended rejects and the queue still drains", async () => {
  const log: string[] = [];
  const { enqueue, awaitTail } = createSessionOperationQueue();

  const running = enqueue(async () => {
    await Promise.resolve();
    log.push("outer");
    try {
      await enqueue(async () => {
        log.push("inner");
      });
    } finally {
      void enqueue(async () => {
        log.push("later");
      });
    }
  });

  await expect(running).rejects.toBeInstanceOf(SessionOperationSelfWaitError);
  await awaitTail();
  expect(log).toEqual(["outer", "inner", "later"]);
});

test("void enqueue from inside an op runs after the outer op and does not reject", async () => {
  const log: string[] = [];
  const rejections: unknown[] = [];
  const onRejection = (err: unknown): void => {
    rejections.push(err);
  };
  process.on("unhandledRejection", onRejection);
  const { enqueue, awaitTail } = createSessionOperationQueue();

  try {
    enqueue(async () => {
      log.push("outer");
      void enqueue(async () => {
        log.push("inner");
      });
      log.push("outer:end");
    });
    await awaitTail();
    expect(log).toEqual(["outer", "outer:end", "inner"]);
    expect(rejections).toEqual([]);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

test("a continuation that enqueues only after the outer op settled is not rejected", async () => {
  const log: string[] = [];
  const { enqueue, awaitTail } = createSessionOperationQueue();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let queued: Promise<void> | undefined;

  enqueue(async () => {
    void (async () => {
      await gate;
      queued = enqueue(async () => {
        log.push("inner");
      });
      log.push("enqueued");
    })();
    log.push("outer");
  });

  await awaitTail();
  expect(log).toEqual(["outer"]);
  release();
  await Promise.resolve();
  await Promise.resolve();
  if (queued === undefined) {
    throw new Error("continuation did not enqueue");
  }
  await queued;
  expect(log).toEqual(["outer", "enqueued", "inner"]);
});

test("an enqueue promise observed only after the outer op settles follows the scheduled op", async () => {
  const log: string[] = [];
  const { enqueue } = createSessionOperationQueue();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let inner: Promise<void> | undefined;

  const outer = enqueue(async () => {
    inner = enqueue(async () => {
      log.push("inner");
    });
    await gate;
    log.push("outer:end");
  });

  await Promise.resolve();
  await Promise.resolve();
  release();
  await outer;
  if (inner === undefined) throw new Error("inner enqueue missing");
  await inner;
  expect(log).toEqual(["outer:end", "inner"]);
});

test("a promise captured inside an op still follows the scheduled op after a later op has started", async () => {
  const log: string[] = [];
  const { enqueue } = createSessionOperationQueue();
  let releaseOuter: () => void = () => undefined;
  const outerGate = new Promise<void>((resolve) => {
    releaseOuter = resolve;
  });
  let releaseInner: () => void = () => undefined;
  const innerGate = new Promise<void>((resolve) => {
    releaseInner = resolve;
  });
  let captured: Promise<void> | undefined;

  const outer = enqueue(async () => {
    captured = enqueue(async () => {
      log.push("inner");
      await innerGate;
      log.push("inner:end");
    });
    await outerGate;
  });

  await Promise.resolve();
  await Promise.resolve();
  releaseOuter();
  await outer;
  await Promise.resolve();
  await Promise.resolve();
  expect(log).toEqual(["inner"]);
  if (captured === undefined) throw new Error("inner enqueue missing");
  let settled = false;
  const pending = captured.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  releaseInner();
  await pending;
  expect(log).toEqual(["inner", "inner:end"]);
});

test("enqueue awaited from outside a running op is not a self-wait", async () => {
  const log: string[] = [];
  const { enqueue } = createSessionOperationQueue();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  enqueue(async () => {
    log.push("outer");
    await gate;
    log.push("outer:end");
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(log).toEqual(["outer"]);

  const pending = enqueue(async () => {
    log.push("inner");
  });
  release();
  await pending;
  expect(log).toEqual(["outer", "outer:end", "inner"]);
});

test("a detached continuation awaiting enqueue while a later op is blocked is not a self-wait", async () => {
  const log: string[] = [];
  const { enqueue, awaitTail } = createSessionOperationQueue();
  let releaseContinuation: () => void = () => undefined;
  const continuationGate = new Promise<void>((resolve) => {
    releaseContinuation = resolve;
  });
  let releaseB: () => void = () => undefined;
  const bGate = new Promise<void>((resolve) => {
    releaseB = resolve;
  });
  let markB: () => void = () => undefined;
  const bStarted = new Promise<void>((resolve) => {
    markB = resolve;
  });

  enqueue(async () => {
    void (async () => {
      await continuationGate;
      log.push("continuation");
      try {
        await enqueue(async () => {
          log.push("work");
        });
        log.push("continuation:done");
      } catch (err) {
        log.push(
          err instanceof SessionOperationSelfWaitError ? "self-wait" : "error",
        );
      }
    })();
    log.push("A");
  });
  enqueue(async () => {
    log.push("B");
    markB();
    releaseContinuation();
    await bGate;
    log.push("B:end");
  });

  await bStarted;
  await Promise.resolve();
  await Promise.resolve();
  expect(log).toEqual(["A", "B", "continuation"]);

  releaseB();
  await awaitTail();
  await Promise.resolve();
  await Promise.resolve();
  expect(log).toEqual([
    "A",
    "B",
    "continuation",
    "B:end",
    "work",
    "continuation:done",
  ]);
});

test("a detached continuation awaiting awaitTail while a later op is blocked is not a self-wait", async () => {
  const log: string[] = [];
  const { enqueue, awaitTail } = createSessionOperationQueue();
  let releaseContinuation: () => void = () => undefined;
  const continuationGate = new Promise<void>((resolve) => {
    releaseContinuation = resolve;
  });
  let releaseB: () => void = () => undefined;
  const bGate = new Promise<void>((resolve) => {
    releaseB = resolve;
  });
  let markB: () => void = () => undefined;
  const bStarted = new Promise<void>((resolve) => {
    markB = resolve;
  });

  enqueue(async () => {
    void (async () => {
      await continuationGate;
      log.push("continuation");
      try {
        await awaitTail();
        log.push("continuation:tail");
      } catch (err) {
        log.push(
          err instanceof SessionOperationSelfWaitError ? "self-wait" : "error",
        );
      }
    })();
    log.push("A");
  });
  enqueue(async () => {
    log.push("B");
    markB();
    releaseContinuation();
    await bGate;
    log.push("B:end");
  });

  await bStarted;
  await Promise.resolve();
  await Promise.resolve();
  expect(log).toEqual(["A", "B", "continuation"]);

  releaseB();
  await awaitTail();
  await Promise.resolve();
  await Promise.resolve();
  expect(log).toEqual(["A", "B", "continuation", "B:end", "continuation:tail"]);
});

test("a self-wait does not leave the queued op's rejection unhandled", async () => {
  const rejections: unknown[] = [];
  const onRejection = (err: unknown): void => {
    rejections.push(err);
  };
  process.on("unhandledRejection", onRejection);
  const { enqueue } = createSessionOperationQueue();

  try {
    const running = enqueue(async () => {
      await enqueue(async () => {
        throw new Error("inner fail");
      });
    });
    await expect(running).rejects.toBeInstanceOf(SessionOperationSelfWaitError);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rejections).toEqual([]);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});
