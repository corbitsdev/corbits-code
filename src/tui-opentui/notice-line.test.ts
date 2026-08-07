import { describe, expect, test } from "bun:test"

import { composeNoticeLine, type NoticeState } from "./notice-line"

const state = (over: Partial<NoticeState> = {}): NoticeState => ({
  queue: 0,
  interrupt: false,
  pinned: false,
  flash: null,
  attachments: 0,
  mcpNeedsAuth: 0,
  ...over,
})

describe("composeNoticeLine", () => {
  test("unauthorized mcp servers hold a standing segment pointing at /mcp", () => {
    expect(composeNoticeLine(state({ mcpNeedsAuth: 1 }))).toBe("1 mcp needs auth (/mcp)")
    expect(composeNoticeLine(state({ mcpNeedsAuth: 2 }))).toBe("2 mcp need auth (/mcp)")
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

