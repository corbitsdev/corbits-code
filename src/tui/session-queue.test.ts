import { describe, expect, test } from "bun:test";
import { defined } from "../../tests/helpers/defined.js";
import {
  badgeCount,
  cancelLast,
  clearInterruptFlash,
  createSessionQueue,
  drainOne,
  drainOrder,
  drainSteersOnly,
  enqueue,
  enqueueSteer,
  interrupt,
  queueCount,
  setRunState,
  steerCount,
  requeueUndelivered,
} from "./session-queue";

describe("session-queue", () => {
  test("empty enqueue is no-op", () => {
    const s0 = createSessionQueue("busy");
    expect(enqueue(s0, "   ")).toBe(s0);
    expect(badgeCount(s0)).toBe(0);
  });

  test("default enqueue is follow-up kind", () => {
    let s = createSessionQueue("busy");
    s = enqueue(s, "hello");
    s = enqueue(s, "world");
    expect(badgeCount(s)).toBe(2);
    expect(s.items.map((i) => i.kind)).toEqual(["queue", "queue"]);
    expect(defined(s.items[0]).text).toBe("hello");
  });

  test("steer and follow-up counts are distinct", () => {
    let s = createSessionQueue("busy");
    s = enqueue(s, "later");
    s = enqueueSteer(s, "asap");
    expect(badgeCount(s)).toBe(2);
    expect(steerCount(s)).toBe(1);
    expect(queueCount(s)).toBe(1);
    expect(defined(s.items[1]).kind).toBe("steer");
  });

  test("drain order: steers before queue", () => {
    let s = createSessionQueue("busy");
    s = enqueue(s, "q1");
    s = enqueueSteer(s, "s1");
    s = enqueue(s, "q2");
    s = enqueueSteer(s, "s2");
    expect(drainOrder(s).map((i) => i.text)).toEqual(["s1", "s2", "q1", "q2"]);

    const d1 = drainOne(s);
    expect(d1.item?.text).toBe("s1");
    const d2 = drainOne(d1.state);
    expect(d2.item?.text).toBe("s2");
    const d3 = drainOne(d2.state);
    expect(d3.item?.text).toBe("q1");
  });

  test("drainOne(kind) is selective; drainSteersOnly leaves follow-ups", () => {
    let s = createSessionQueue("busy");
    s = enqueue(s, "q1");
    s = enqueueSteer(s, "s1");
    s = enqueue(s, "q2");
    s = enqueueSteer(s, "s2");

    const onlySteer = drainOne(s, "steer");
    expect(onlySteer.item?.text).toBe("s1");
    expect(queueCount(onlySteer.state)).toBe(2);
    expect(steerCount(onlySteer.state)).toBe(1);

    const steersGone = drainSteersOnly(onlySteer.state);
    expect(steersGone.drained.map((i) => i.text)).toEqual(["s2"]);
    expect(steerCount(steersGone.state)).toBe(0);
    expect(queueCount(steersGone.state)).toBe(2);
    expect(drainOrder(steersGone.state).map((i) => i.text)).toEqual([
      "q1",
      "q2",
    ]);

    const onlyQueue = drainOne(steersGone.state, "queue");
    expect(onlyQueue.item?.text).toBe("q1");
    expect(queueCount(onlyQueue.state)).toBe(1);
  });

  test("Ctrl+C interrupt keeps pending + sets flash + idle", () => {
    let s = createSessionQueue("busy");
    s = enqueue(s, "a");
    s = enqueueSteer(s, "b");
    s = interrupt(s);
    expect(drainOrder(s).map((i) => i.text)).toEqual(["b", "a"]);
    expect(s.interruptFlash).toBe(true);
    expect(s.run).toBe("idle");
    s = clearInterruptFlash(s);
    expect(s.interruptFlash).toBe(false);
  });

  test("cancelLast retracts the newest queue item", () => {
    let s = createSessionQueue("busy");
    s = enqueue(s, "keep");
    s = enqueue(s, "drop");
    const { state, item } = cancelLast(s);
    expect(item?.text).toBe("drop");
    expect(badgeCount(state)).toBe(1);
    expect(defined(state.items[0]).text).toBe("keep");
  });

  test("cancelLast retracts the newest steer item, same as queue", () => {
    let s = createSessionQueue("busy");
    s = enqueue(s, "queued");
    s = enqueueSteer(s, "steered");
    const { state, item } = cancelLast(s);
    expect(item?.kind).toBe("steer");
    expect(item?.text).toBe("steered");
    expect(badgeCount(state)).toBe(1);
    expect(defined(state.items[0]).kind).toBe("queue");
  });

  test("cancelLast on an empty queue is a no-op", () => {
    const s = createSessionQueue("busy");
    const { state, item } = cancelLast(s);
    expect(item).toBeNull();
    expect(state).toBe(s);
  });

  test("setRunState toggles busy/idle", () => {
    let s = createSessionQueue("idle");
    s = setRunState(s, "busy");
    expect(s.run).toBe("busy");
    s = setRunState(s, "busy");
    expect(s.run).toBe("busy");
  });

  test("requeueUndelivered keeps the same id at the front of its kind class", () => {
    let s = createSessionQueue("busy");
    s = enqueue(s, "q1");
    s = enqueueSteer(s, "s1");
    s = enqueue(s, "q2");
    s = enqueueSteer(s, "s2");
    const drained = drainOne(s, "steer");
    const item = defined(drained.item, "drained steer");
    expect(item.id).toBe("q2");
    s = requeueUndelivered(drained.state, item);
    expect(s.items.map((i) => i.id)).toEqual(["q2", "q4", "q1", "q3"]);
    expect(defined(s.items[0]).text).toBe("s1");
    expect(defined(s.items[0]).kind).toBe("steer");
    expect(drainOrder(s).map((i) => i.text)).toEqual(["s1", "s2", "q1", "q2"]);
  });

  test("requeueUndelivered restores queue items ahead of later follow-ups", () => {
    let s = createSessionQueue("busy");
    s = enqueue(s, "first");
    s = enqueueSteer(s, "asap");
    s = enqueue(s, "second");
    const drained = drainOne(s, "queue");
    const item = defined(drained.item, "drained queue");
    s = requeueUndelivered(drained.state, item);
    expect(item.id).toBe("q1");
    expect(s.items.filter((i) => i.kind === "queue").map((i) => i.id)).toEqual([
      "q1",
      "q3",
    ]);
    expect(defined(s.items.find((i) => i.id === "q1")).text).toBe("first");
    expect(s.nextId).toBe(4);
  });

  test("requeueUndelivered keeps attachments on the original item", () => {
    const image = {
      id: "img-1",
      name: "clip.png",
      contentType: "image/png",
      data: new Uint8Array([1]),
      contentHash: "hash-1",
    };
    let s = createSessionQueue("busy");
    s = enqueue(s, "with pic", "queue", Date.now(), [image]);
    const drained = drainOne(s);
    const item = defined(drained.item, "drained item");
    s = requeueUndelivered(drained.state, item);
    expect(defined(s.items[0]).attachments).toEqual([image]);
    expect(defined(s.items[0]).id).toBe(item.id);
  });
});
