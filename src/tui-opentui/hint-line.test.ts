import { describe, expect, test } from "bun:test"
import { composeHintLine, type HintState } from "./hint-line"

function state(overrides: Partial<HintState> = {}): HintState {
  return {
    surface: { kind: "prompt" },
    run: "idle",
    workers: false,
    queue: 0,
    interrupt: false,
    pinned: false,
    phase: null,
    flash: null,
    attachments: 0,
    ...overrides,
  }
}

describe("composeHintLine", () => {
  test("idle offers commands and file mentions", () => {
    expect(composeHintLine(state())).toBe(
      "/ commands    @ files",
    )
  })

  test("running swaps file mentions for the stop key", () => {
    expect(composeHintLine(state({ run: "busy" }))).toBe(
      "/ commands    ^C stop",
    )
  })

  test("live workers advertise the observe key", () => {
    expect(composeHintLine(state({ run: "busy", workers: true }))).toBe(
      "alt+a workers    / commands    ^C stop",
    )
  })

  test("never advertises enter to send", () => {
    for (const surface of [
      { kind: "prompt" },
      { kind: "transcript" },
      { kind: "observe" },
    ] as const) {
      expect(composeHintLine(state({ surface }))).not.toContain("enter send")
    }
  })

  test("an open overlay shows its own keys", () => {
    expect(
      composeHintLine(state({ surface: { kind: "overlay", filterable: true } })),
    ).toBe("↑↓ move    type filter    enter accept    esc close")
  })

  test("default state adds no counters", () => {
    const line = composeHintLine(state({ queue: 0, pinned: false }))
    expect(line).not.toContain("queue")
    expect(line).not.toContain("pinned")
  })

  test("non-default state surfaces after the keys", () => {
    const line = composeHintLine(
      state({
        run: "busy",
        queue: 2,
        pinned: true,
        interrupt: true,
        phase: "Working…",
        attachments: 1,
        flash: "copied 3 rows",
      }),
    )
    expect(line).toBe(
      "/ commands    ^C stop    working    queue 2    pinned    interrupt    1 image    copied 3 rows",
    )
  })
})
