import { describe, expect, test } from "bun:test"

import { composeNoticeLine, rampPrefix, type NoticeState } from "./notice-line"

const state = (over: Partial<NoticeState> = {}): NoticeState => ({
  queue: 0,
  interrupt: false,
  pinned: false,
  phase: null,
  flash: null,
  attachments: 0,
  ...over,
})

describe("composeNoticeLine", () => {
  test("an idle shell has nothing to say and takes no row", () => {
    expect(composeNoticeLine(state())).toBe("")
  })

  test("a live turn contributes its ramp and not the phase word", () => {
    const line = composeNoticeLine(state({ phase: "███▓▒░  working" }))
    expect(line).toBe("███▓▒░")
    expect(line).not.toContain("working")
  })

  test("default state segments stay off the row", () => {
    const line = composeNoticeLine(state({ queue: 0, pinned: false }))
    expect(line).not.toContain("queue")
    expect(line).not.toContain("pinned")
  })

  test("non-default state earns its place", () => {
    const line = composeNoticeLine(
      state({ queue: 2, pinned: true, interrupt: true, attachments: 1 }),
    )
    expect(line).toContain("queue 2")
    expect(line).toContain("pinned")
    expect(line).toContain("interrupt")
    expect(line).toContain("1 image")
  })

  test("a flash is carried verbatim so paths keep their case", () => {
    expect(composeNoticeLine(state({ flash: "attached Screenshot.png" }))).toBe(
      "attached Screenshot.png",
    )
  })

  test("no keys strip survives anywhere in the composition", () => {
    const line = composeNoticeLine(
      state({ queue: 1, interrupt: true, phase: "██  thinking" }),
    )
    expect(line).not.toContain("commands")
    expect(line).not.toContain("files")
    expect(line).not.toContain("^C")
  })
})

describe("rampPrefix", () => {
  test("takes the density glyphs and stops at the label", () => {
    expect(rampPrefix("███▓▒░  working · 14s")).toBe("███▓▒░")
    expect(rampPrefix(null)).toBe("")
    expect(rampPrefix("working")).toBe("")
  })
})
