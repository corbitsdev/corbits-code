import { describe, expect, test } from "bun:test"

import {
  RAMP_CYCLE_MS,
  RAMP_WIDTH,
  rampFor,
  rampLine,
  renderIndeterminateRamp,
  renderRamp,
} from "./ramp"
import { UI } from "./theme"

const BRAILLE = /[⠀-⣿]/

describe("renderRamp", () => {
  test("is always the requested width", () => {
    for (const p of [0, 0.13, 0.5, 0.77, 1]) {
      expect(renderRamp(p).length).toBe(RAMP_WIDTH)
    }
  })

  test("empty at zero", () => {
    expect(renderRamp(0)).toBe("▓▒░       ")
  })

  test("feathers the leading edge mid-fill", () => {
    expect(renderRamp(0.7)).toBe("███████▓▒░")
  })

  test("a complete ramp is solid", () => {
    expect(renderRamp(1)).toBe("██████████")
  })

  test("clamps out-of-range and non-finite progress", () => {
    expect(renderRamp(5)).toBe("██████████")
    expect(renderRamp(-1)).toBe(renderRamp(0))
    expect(renderRamp(Number.NaN)).toBe(renderRamp(0))
  })

  test("honors a custom width", () => {
    expect(renderRamp(1, 4)).toBe("████")
    expect(renderRamp(0.5, 0)).toBe("")
  })
})

describe("renderIndeterminateRamp", () => {
  test("is always the requested width", () => {
    for (let t = 0; t < RAMP_CYCLE_MS; t += 97) {
      expect(renderIndeterminateRamp(t).length).toBe(RAMP_WIDTH)
    }
  })

  test("the comet travels left to right", () => {
    const early = renderIndeterminateRamp(0)
    const later = renderIndeterminateRamp(RAMP_CYCLE_MS / 2)
    expect(early.indexOf("█")).toBeLessThan(later.indexOf("█"))
  })

  test("wraps on the cycle", () => {
    expect(renderIndeterminateRamp(RAMP_CYCLE_MS + 40)).toBe(
      renderIndeterminateRamp(40),
    )
  })

  test("never fakes a completed ramp", () => {
    for (let t = 0; t < RAMP_CYCLE_MS; t += 13) {
      expect(renderIndeterminateRamp(t)).not.toBe("██████████")
    }
  })
})

describe("rampFor", () => {
  test("working animates in the in-flight bronze", () => {
    const ramp = rampFor({ phase: "working", nowMs: 0 })
    expect(ramp.fg).toBe(UI.inFlight)
    expect(ramp.animating).toBe(true)
  })

  test("working advances with the clock", () => {
    const a = rampFor({ phase: "working", nowMs: 0 })
    const b = rampFor({ phase: "working", nowMs: RAMP_CYCLE_MS / 2 })
    expect(a.cells).not.toBe(b.cells)
  })

  test("working with known progress fills rather than travels", () => {
    expect(rampFor({ phase: "working", nowMs: 0, progress: 0.7 }).cells).toBe(
      "███████▓▒░",
    )
  })

  test("done is solid Ridge Green and stops animating", () => {
    const ramp = rampFor({ phase: "done", nowMs: 12_345 })
    expect(ramp.cells).toBe("██████████")
    expect(ramp.fg).toBe(UI.done)
    expect(ramp.animating).toBe(false)
  })

  test("done ignores the clock", () => {
    expect(rampFor({ phase: "done", nowMs: 0 }).cells).toBe(
      rampFor({ phase: "done", nowMs: 99_999 }).cells,
    )
  })

  test("blocked freezes mid-fill in Breakthrough Orange", () => {
    const ramp = rampFor({ phase: "blocked", nowMs: 0 })
    expect(ramp.fg).toBe(UI.action)
    expect(ramp.animating).toBe(false)
    expect(ramp.cells).toContain("█")
    expect(ramp.cells).not.toBe("██████████")
  })

  test("blocked ignores the clock", () => {
    expect(rampFor({ phase: "blocked", nowMs: 500 }).cells).toBe(
      rampFor({ phase: "blocked", nowMs: 900_000 }).cells,
    )
  })

  test("no phase emits a braille spinner glyph", () => {
    for (const phase of ["working", "done", "blocked"] as const) {
      expect(rampFor({ phase, nowMs: 400 }).cells).not.toMatch(BRAILLE)
    }
  })
})

describe("rampLine", () => {
  test("composes ramp, lowercase label and elapsed seconds", () => {
    const ramp = rampFor({ phase: "working", nowMs: 0, progress: 0.7 })
    expect(rampLine(ramp, "working", 14_400)).toBe("███████▓▒░  working · 14s")
  })

  test("omits elapsed when unknown", () => {
    const ramp = rampFor({ phase: "done", nowMs: 0 })
    expect(rampLine(ramp, "done")).toBe("██████████  done")
  })
})
