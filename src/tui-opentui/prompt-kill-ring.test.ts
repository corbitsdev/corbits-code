import { describe, expect, test } from "bun:test"
import {
  beginYank,
  breakKillSequence,
  emptyKillRing,
  killedTextBackward,
  killedTextForward,
  recordKill,
  rotateYank,
} from "./prompt-kill-ring"

describe("recordKill / beginYank", () => {
  test("a single kill can be yanked back", () => {
    const ring = recordKill(emptyKillRing, "world", "forward")
    const yank = beginYank(ring, 5)
    expect(yank).not.toBeNull()
    expect(yank!.text).toBe("world")
  })

  test("consecutive forward kills accumulate in order", () => {
    let ring = recordKill(emptyKillRing, "foo", "forward")
    ring = recordKill(ring, "bar", "forward")
    const yank = beginYank(ring, 0)
    expect(yank!.text).toBe("foobar")
  })

  test("consecutive backward kills prepend so original order survives", () => {
    let ring = recordKill(emptyKillRing, "bar", "backward")
    ring = recordKill(ring, "foo", "backward")
    const yank = beginYank(ring, 0)
    expect(yank!.text).toBe("foobar")
  })

  test("a non-kill breaks accumulation: a later kill starts a fresh entry", () => {
    let ring = recordKill(emptyKillRing, "foo", "forward")
    ring = breakKillSequence(ring)
    ring = recordKill(ring, "bar", "forward")
    expect(ring.entries[0]).toBe("bar")
    expect(ring.entries[1]).toBe("foo")
  })

  test("empty kill text is a no-op that still breaks the sequence", () => {
    const ring = recordKill(emptyKillRing, "", "forward")
    expect(ring).toEqual(emptyKillRing)
  })
})

describe("rotateYank", () => {
  test("rotates to the next-older entry after a yank", () => {
    let ring = recordKill(emptyKillRing, "second", "forward")
    ring = recordKill(breakKillSequence(ring), "first", "forward")
    const yank = beginYank(ring, 0)!
    expect(yank.text).toBe("first")
    const rotated = rotateYank(yank.ring)
    expect(rotated).not.toBeNull()
    expect(rotated!.text).toBe("second")
    expect(rotated!.span).toEqual({ start: 0, end: 5 })
  })

  test("returns null when the previous command was not a yank", () => {
    const ring = recordKill(emptyKillRing, "text", "forward")
    expect(rotateYank(ring)).toBeNull()
  })

  test("returns null when nothing has ever been killed", () => {
    expect(rotateYank(emptyKillRing)).toBeNull()
  })

  test("wraps back to the first entry after cycling through all of them", () => {
    let ring = recordKill(emptyKillRing, "b", "forward")
    ring = recordKill(breakKillSequence(ring), "a", "forward")
    const yank = beginYank(ring, 0)!
    const once = rotateYank(yank.ring)!
    expect(once.text).toBe("b")
    const twice = rotateYank(once.ring)!
    expect(twice.text).toBe("a")
  })
})

describe("killedTextForward / killedTextBackward", () => {
  test("forward diff reads the removed slice starting at the cursor", () => {
    expect(killedTextForward("hello world", 5, "hello")).toBe(" world")
  })

  test("forward diff is empty when the buffer did not shrink", () => {
    expect(killedTextForward("hello", 2, "hello")).toBe("")
  })

  test("backward diff reads the removed slice ending at the old cursor", () => {
    expect(killedTextBackward("hello world", 11, 6)).toBe("world")
  })

  test("backward diff is empty when the cursor did not move back", () => {
    expect(killedTextBackward("hello", 3, 3)).toBe("")
  })
})
