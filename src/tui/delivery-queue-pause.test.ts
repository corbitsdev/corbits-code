import { describe, expect, test } from "bun:test";
import {
  createSessionQueue,
  enqueue,
  enqueueSteer,
  interrupt,
  isPaused,
  pause,
  resumeForSend,
  badgeCount,
} from "./delivery-queue";

/**
 * Phase 1 (CL-10149) pins the `paused` state and its pure helpers. The drain
 * gate that consumes this flag ships in Phase 2; here we assert only the state
 * transitions — pause never drops items and resumeForSend clears the flag
 * without touching the queue.
 */
describe("delivery-queue pause", () => {
  test("createSessionQueue defaults to not paused", () => {
    const s = createSessionQueue("busy");
    expect(isPaused(s)).toBe(false);
  });

  test("pause after interrupt holds queue items and sets paused", () => {
    let s = createSessionQueue("busy");
    s = enqueue(s, "follow-up");
    s = enqueueSteer(s, "steer");
    s = interrupt(s);
    s = pause(s);
    expect(isPaused(s)).toBe(true);
    // NG2: pause keeps every queued item.
    expect(badgeCount(s)).toBe(2);
    expect(s.items.map((i) => i.text)).toEqual(["follow-up", "steer"]);
  });

  test("resumeForSend clears paused and keeps items intact", () => {
    let s = createSessionQueue("busy");
    s = enqueue(s, "follow-up");
    s = pause(s);
    expect(isPaused(s)).toBe(true);
    const resumed = resumeForSend(s);
    expect(isPaused(resumed)).toBe(false);
    // No item is dropped by the resume.
    expect(resumed.items.map((i) => i.text)).toEqual(["follow-up"]);
    expect(badgeCount(resumed)).toBe(1);
  });

  test("enqueue while paused accepts items and does not auto-resume", () => {
    let s = createSessionQueue("busy");
    s = pause(s);
    s = enqueue(s, "queued-while-paused");
    expect(isPaused(s)).toBe(true);
    expect(badgeCount(s)).toBe(1);
  });
});
