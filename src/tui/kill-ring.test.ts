import { describe, test, expect } from "bun:test";
import {
  KILL_RING_MAX,
  beginYank,
  breakKillSequence,
  emptyKillRing,
  recordKill,
  rotateYank,
  type KillRing,
} from "./kill-ring.js";

describe("recordKill", () => {
  test("pushes killed text to the front", () => {
    let ring = recordKill(emptyKillRing, "one", "forward");
    ring = breakKillSequence(ring);
    ring = recordKill(ring, "two", "forward");
    expect(ring.entries).toEqual(["two", "one"]);
  });

  test("empty text does not create an entry", () => {
    const ring = recordKill(emptyKillRing, "", "forward");
    expect(ring.entries).toEqual([]);
  });

  test("consecutive forward kills append to one entry", () => {
    let ring = recordKill(emptyKillRing, "foo ", "forward");
    ring = recordKill(ring, "bar", "forward");
    expect(ring.entries).toEqual(["foo bar"]);
  });

  test("consecutive backward kills prepend to one entry", () => {
    let ring = recordKill(emptyKillRing, "bar", "backward");
    ring = recordKill(ring, "foo ", "backward");
    expect(ring.entries).toEqual(["foo bar"]);
  });

  test("mixed directions still accumulate into one entry", () => {
    let ring = recordKill(emptyKillRing, "mid", "forward");
    ring = recordKill(ring, "pre ", "backward");
    ring = recordKill(ring, " post", "forward");
    expect(ring.entries).toEqual(["pre mid post"]);
  });

  test("an intervening non-kill command starts a new entry", () => {
    let ring = recordKill(emptyKillRing, "one", "forward");
    ring = breakKillSequence(ring);
    ring = recordKill(ring, "two", "forward");
    expect(ring.entries).toEqual(["two", "one"]);
  });

  test("ring is capped at KILL_RING_MAX entries", () => {
    let ring: KillRing = emptyKillRing;
    for (let i = 0; i < KILL_RING_MAX + 3; i++) {
      ring = breakKillSequence(ring);
      ring = recordKill(ring, `kill${i}`, "forward");
    }
    expect(ring.entries.length).toBe(KILL_RING_MAX);
    expect(ring.entries[0]).toBe(`kill${KILL_RING_MAX + 2}`);
  });

  test("a new kill resets yank rotation to the newest entry", () => {
    let ring = recordKill(emptyKillRing, "one", "forward");
    ring = breakKillSequence(ring);
    ring = recordKill(ring, "two", "forward");
    const yank = beginYank(ring, 0)!;
    const rotated = rotateYank(yank.ring)!;
    expect(rotated.ring.yankIndex).toBe(1);
    let next = breakKillSequence(rotated.ring);
    next = recordKill(next, "three", "forward");
    expect(beginYank(next, 0)!.text).toBe("three");
  });
});

describe("beginYank", () => {
  test("returns null when nothing has been killed", () => {
    expect(beginYank(emptyKillRing, 0)).toBeNull();
  });

  test("yanks the most recent kill and records the span", () => {
    const ring = recordKill(emptyKillRing, "hello", "forward");
    const yank = beginYank(ring, 3)!;
    expect(yank.text).toBe("hello");
    expect(yank.ring.lastYankSpan).toEqual({ start: 3, end: 8 });
  });

  test("re-yank after rotation uses the rotated entry", () => {
    let ring = recordKill(emptyKillRing, "one", "forward");
    ring = breakKillSequence(ring);
    ring = recordKill(ring, "two", "forward");
    const first = beginYank(ring, 0)!;
    const rotated = rotateYank(first.ring)!;
    const settled = breakKillSequence(rotated.ring);
    expect(beginYank(settled, 0)!.text).toBe("one");
  });
});

describe("rotateYank", () => {
  test("returns null when the previous command was not a yank", () => {
    const ring = recordKill(emptyKillRing, "one", "forward");
    expect(rotateYank(ring)).toBeNull();
  });

  test("returns null on an empty ring", () => {
    expect(rotateYank(emptyKillRing)).toBeNull();
  });

  test("replaces the yanked span with the next-older kill", () => {
    let ring = recordKill(emptyKillRing, "one", "forward");
    ring = breakKillSequence(ring);
    ring = recordKill(ring, "two", "forward");
    const yank = beginYank(ring, 5)!;
    const rotated = rotateYank(yank.ring)!;
    expect(rotated.span).toEqual({ start: 5, end: 8 });
    expect(rotated.text).toBe("one");
    expect(rotated.ring.lastYankSpan).toEqual({ start: 5, end: 8 });
  });

  test("wraps around to the newest entry", () => {
    let ring = recordKill(emptyKillRing, "one", "forward");
    ring = breakKillSequence(ring);
    ring = recordKill(ring, "two", "forward");
    const yank = beginYank(ring, 0)!;
    const r1 = rotateYank(yank.ring)!;
    const r2 = rotateYank(r1.ring)!;
    expect(r2.text).toBe("two");
  });

  test("any non-yank command ends the rotation window", () => {
    const ring = recordKill(emptyKillRing, "one", "forward");
    const yank = beginYank(ring, 0)!;
    const broken = breakKillSequence(yank.ring);
    expect(rotateYank(broken)).toBeNull();
  });
});
