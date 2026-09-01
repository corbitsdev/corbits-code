import { describe, expect, test } from "bun:test";
import type { PendingImageAttachment } from "./image-attachments.js";
import {
  createDeliveryGeneration,
  createLeftoverSend,
  createLiveSteerDeliver,
  routeQueuedDelivery,
} from "./queued-delivery.js";
import { createSessionOperationQueue } from "./session-operation-queue.js";

const image: PendingImageAttachment = {
  id: "img-1",
  name: "clipboard.png",
  contentType: "image/png",
  data: new Uint8Array([1]),
  contentHash: "hash-1",
};

function recordHops(parentCycleLive: () => boolean) {
  const sends: string[] = [];
  const steers: string[] = [];
  const deliver = routeQueuedDelivery({
    send: (text) => {
      sends.push(text);
    },
    deliverSteer: (text) => {
      steers.push(text);
    },
    parentCycleLive,
  });
  return { deliver, sends, steers };
}

describe("routeQueuedDelivery", () => {
  test("live parent-boundary steer calls deliverSteer only", () => {
    const { deliver, sends, steers } = recordHops(() => true);
    deliver("asap", "steer");
    expect(steers).toEqual(["asap"]);
    expect(sends).toEqual([]);
  });

  test("leftover steer (idle / fleet-hold / post-interrupt) calls send only", () => {
    const { deliver, sends, steers } = recordHops(() => false);
    deliver("leftover", "steer");
    expect(sends).toEqual(["leftover"]);
    expect(steers).toEqual([]);
  });

  test("queue calls send only, even while the parent cycle is live", () => {
    const { deliver, sends, steers } = recordHops(() => true);
    deliver("later", "queue");
    expect(sends).toEqual(["later"]);
    expect(steers).toEqual([]);
  });

  test("forwards attachments on both hops", () => {
    const sent: (readonly PendingImageAttachment[] | undefined)[] = [];
    const steered: (readonly PendingImageAttachment[] | undefined)[] = [];
    const live = routeQueuedDelivery({
      send: (_text, attachments) => {
        sent.push(attachments);
      },
      deliverSteer: (_text, attachments) => {
        steered.push(attachments);
      },
      parentCycleLive: () => true,
    });
    const leftover = routeQueuedDelivery({
      send: (_text, attachments) => {
        sent.push(attachments);
      },
      deliverSteer: (_text, attachments) => {
        steered.push(attachments);
      },
      parentCycleLive: () => false,
    });
    live("asap", "steer", [image]);
    leftover("later", "steer", [image]);
    leftover("follow", "queue", [image]);
    expect(steered).toEqual([[image]]);
    expect(sent).toEqual([[image], [image]]);
  });
});

describe("createDeliveryGeneration", () => {
  test("capture then bump → predicate false", () => {
    const generation = createDeliveryGeneration();
    const stillCurrent = generation.capture();
    generation.bump();
    expect(stillCurrent()).toBe(false);
  });

  test("capture without bump → true", () => {
    const generation = createDeliveryGeneration();
    const stillCurrent = generation.capture();
    expect(stillCurrent()).toBe(true);
  });

  test("bump then new capture → true", () => {
    const generation = createDeliveryGeneration();
    generation.bump();
    const stillCurrent = generation.capture();
    expect(stillCurrent()).toBe(true);
  });

  test("two captures, bump, both stale", () => {
    const generation = createDeliveryGeneration();
    const first = generation.capture();
    const second = generation.capture();
    generation.bump();
    expect(first()).toBe(false);
    expect(second()).toBe(false);
  });
});

describe("createLiveSteerDeliver", () => {
  test("slow first ingest does not let a later steer deliver first", async () => {
    const delivered: string[] = [];
    const { enqueue, awaitTail } = createSessionOperationQueue();
    let resolveSlow!: () => void;
    const slow = new Promise<void>((resolve) => {
      resolveSlow = resolve;
    });
    const deliverSteer = createLiveSteerDeliver({
      enqueue,
      ingest: async (text) => {
        if (text.startsWith("@mention")) await slow;
        return { text, attachments: [] };
      },
      deliver: (text) => {
        delivered.push(text);
      },
      captureGeneration: () => () => true,
      onFailure: (err) => {
        throw err;
      },
    });

    deliverSteer("@mention A");
    deliverSteer("plain B");
    await Promise.resolve();
    await Promise.resolve();
    expect(delivered).toEqual([]);

    resolveSlow();
    await awaitTail();
    expect(delivered).toEqual(["@mention A", "plain B"]);
  });

  test("generation bump during ingest drops both in-flight live steers", async () => {
    const delivered: string[] = [];
    const { enqueue, awaitTail } = createSessionOperationQueue();
    const generation = createDeliveryGeneration();
    let resolveSlow!: () => void;
    const slow = new Promise<void>((resolve) => {
      resolveSlow = resolve;
    });
    const deliverSteer = createLiveSteerDeliver({
      enqueue,
      ingest: async (text) => {
        if (text === "A") await slow;
        return { text, attachments: [] };
      },
      deliver: (text) => {
        delivered.push(text);
      },
      captureGeneration: generation.capture,
      onFailure: (err) => {
        throw err;
      },
    });

    deliverSteer("A");
    deliverSteer("B");
    generation.bump();
    resolveSlow();
    await awaitTail();
    expect(delivered).toEqual([]);
  });
});

describe("createLeftoverSend", () => {
  test("generation bump during ingest drops leftover send and sent-message record", async () => {
    const sent: string[] = [];
    const recorded: string[] = [];
    const { enqueue, awaitTail } = createSessionOperationQueue();
    const generation = createDeliveryGeneration();
    let resolveSlow!: () => void;
    const slow = new Promise<void>((resolve) => {
      resolveSlow = resolve;
    });
    const leftoverSend = createLeftoverSend({
      enqueue,
      ingest: async (text) => {
        if (text === "leftover") await slow;
        return { text, attachments: [] };
      },
      send: (text) => {
        sent.push(text);
      },
      recordSent: (text) => {
        recorded.push(text);
      },
      captureGeneration: generation.capture,
      onFailure: (err) => {
        throw err;
      },
    });

    leftoverSend("leftover");
    generation.bump();
    resolveSlow();
    await awaitTail();
    expect(sent).toEqual([]);
    expect(recorded).toEqual([]);
  });

  test("leftover send without a bump still sends and records", async () => {
    const sent: string[] = [];
    const recorded: string[] = [];
    const { enqueue, awaitTail } = createSessionOperationQueue();
    const leftoverSend = createLeftoverSend({
      enqueue,
      ingest: async (text) => ({ text, attachments: [] }),
      send: (text) => {
        sent.push(text);
      },
      recordSent: (text) => {
        recorded.push(text);
      },
      captureGeneration: () => () => true,
      onFailure: (err) => {
        throw err;
      },
    });

    leftoverSend("follow-up");
    await awaitTail();
    expect(sent).toEqual(["follow-up"]);
    expect(recorded).toEqual(["follow-up"]);
  });

  test("generation bump drops leftover send but not a sibling Enter send", async () => {
    const leftoverSent: string[] = [];
    const enterSent: string[] = [];
    const { enqueue, awaitTail } = createSessionOperationQueue();
    const generation = createDeliveryGeneration();
    let resolveSlow!: () => void;
    const slow = new Promise<void>((resolve) => {
      resolveSlow = resolve;
    });
    const leftoverSend = createLeftoverSend({
      enqueue,
      ingest: async (text) => {
        await slow;
        return { text, attachments: [] };
      },
      send: (text) => {
        leftoverSent.push(text);
      },
      captureGeneration: generation.capture,
      onFailure: (err) => {
        throw err;
      },
    });
    const enterSend = (text: string) => {
      enterSent.push(text);
    };

    leftoverSend("queued");
    generation.bump();
    enterSend("hello");
    resolveSlow();
    await awaitTail();
    expect(leftoverSent).toEqual([]);
    expect(enterSent).toEqual(["hello"]);
  });
});
