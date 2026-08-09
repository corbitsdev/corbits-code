import { describe, expect, test } from "bun:test"

import { composeNoticeLine, type NoticeState } from "./notice-line"

const state = (over: Partial<NoticeState> = {}): NoticeState => ({
  queue: 0,
  interrupt: false,
  pinned: false,
  flash: null,
  attachments: 0,
  mcpNeedsAuth: [],
  ...over,
})

describe("composeNoticeLine", () => {
  test("the standing mcp segment names the servers it means", () => {
    expect(composeNoticeLine(state({ mcpNeedsAuth: ["granola"] }))).toBe(
      "mcp granola needs auth (/mcp)",
    )
    expect(composeNoticeLine(state({ mcpNeedsAuth: ["linear", "granola"] }))).toBe(
      "mcp granola, linear needs auth (/mcp)",
    )
  })

  test("past two servers the segment counts the rest rather than growing", () => {
    expect(
      composeNoticeLine(state({ mcpNeedsAuth: ["d", "a", "c", "b"] })),
    ).toBe("mcp a, b +2 needs auth (/mcp)")
  })

  test("an idle shell has nothing to say and takes no row", () => {
    expect(composeNoticeLine(state())).toBe("")
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
      state({ queue: 1, interrupt: true }),
    )
    expect(line).not.toContain("commands")
    expect(line).not.toContain("files")
    expect(line).not.toContain("^C")
  })
})

