import { describe, expect, test } from "bun:test";
import type { PendingImageAttachment } from "./image-attachments.js";
import { createDeliveryGeneration, routeQueuedDelivery } from "./queued-delivery.js";

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
