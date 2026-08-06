import { describe, expect, test } from "bun:test"

import {
  MARK_PERIOD_SECONDS,
  ditherTone,
  markFrame,
  markText,
  markWave,
  renderMark,
  smooth,
} from "./mark-anim"
import { MARK_COLS, MARK_COVERAGE, MARK_ROWS } from "./mark-shape"
import { UI } from "./theme"

describe("smooth", () => {
  test("clamps outside [0, 1] and eases inside it", () => {
    expect(smooth(-3)).toBe(0)
    expect(smooth(0)).toBe(0)
    expect(smooth(0.5)).toBe(0.5)
    expect(smooth(1)).toBe(1)
    expect(smooth(9)).toBe(1)
    // Eased, not linear: the first quarter moves less than a quarter.
    expect(smooth(0.25)).toBeLessThan(0.25)
  })
})

describe("markFrame", () => {
  test("draws in, holds, fills bottom-up, holds, then fades", () => {
    const at = (phase: number) => markFrame(phase * MARK_PERIOD_SECONDS, false)

    expect(at(0)).toEqual({ drawProg: 0, fillProg: 0, alpha: 1 })
    expect(at(0.19).drawProg).toBeCloseTo(0.5, 6)
    expect(at(0.37).fillProg).toBe(0)

    // Hold: outline complete, nothing filled.
    expect(at(0.38)).toEqual({ drawProg: 1, fillProg: 0, alpha: 1 })
    expect(at(0.47)).toEqual({ drawProg: 1, fillProg: 0, alpha: 1 })

    // Fill.
    expect(at(0.48).fillProg).toBeCloseTo(0, 6)
    expect(at(0.62).fillProg).toBeCloseTo(0.5, 6)
    expect(at(0.75).fillProg).toBeGreaterThan(0.99)

    // Hold full.
    expect(at(0.76)).toEqual({ drawProg: 1, fillProg: 1, alpha: 1 })
    expect(at(0.89)).toEqual({ drawProg: 1, fillProg: 1, alpha: 1 })

    // Fade out.
    expect(at(0.9).alpha).toBe(1)
    expect(at(0.95).alpha).toBeCloseTo(0.5, 6)
    expect(at(0.999).alpha).toBeLessThan(0.01)
  })

  test("loops on the period and handles a negative clock", () => {
    expect(markFrame(1.2, false)).toEqual(markFrame(1.2 + MARK_PERIOD_SECONDS, false))
    expect(markFrame(-0.1, false).alpha).toBeLessThan(1)
  })

  test("still is a fully drawn, fully filled mark at any time", () => {
    for (const t of [0, 1.7, 4.59, 12345.678]) {
      expect(markFrame(t, true)).toEqual({ drawProg: 1, fillProg: 1, alpha: 1 })
    }
  })
})

describe("markWave", () => {
  test("still pins the wave regardless of the clock", () => {
    expect(markWave(3, 2, 0, true)).toBe(markWave(3, 2, 99, true))
  })

  test("moving field changes with time", () => {
    expect(markWave(3, 2, 0, false)).not.toBe(markWave(3, 2, 1, false))
  })
})

describe("ditherTone", () => {
  test("paints only the two brand orange tones", () => {
    for (let row = 0; row < MARK_ROWS; row++) {
      for (let col = 0; col < MARK_COLS; col++) {
        const tone: string = ditherTone(col, row, 1.3, false)
        expect([UI.action, UI.actionDim] as readonly string[]).toContain(tone)
      }
    }
  })

  test("the ordered matrix splits neighbours at a fixed wave", () => {
    // Same wave value, different Bayer slots: the tones must not agree, or the
    // gradient would band instead of dither.
    const tones = new Set([
      ditherTone(0, 0, 0, true),
      ditherTone(1, 0, 0, true),
      ditherTone(0, 1, 0, true),
      ditherTone(3, 0, 0, true),
    ])
    expect(tones.size).toBe(2)
  })
})

describe("renderMark", () => {
  const emptyCells = (grid: readonly (readonly { char: string }[])[]): number =>
    grid.flat().filter((cell) => cell.char === " ").length

  test("is the mark's cell dimensions", () => {
    const grid = renderMark({ nowMs: 0, still: true })
    expect(grid).toHaveLength(MARK_ROWS)
    for (const row of grid) expect(row).toHaveLength(MARK_COLS)
  })

  test("never paints outside the silhouette", () => {
    const grid = renderMark({ nowMs: 2000, still: false })
    grid.forEach((row, y) => {
      row.forEach((cell, x) => {
        if ((MARK_COVERAGE[y]?.[x] ?? 0) === 0) expect(cell.char).toBe(" ")
      })
    })
  })

  test("the still frame is clock-independent", () => {
    const a = markText(renderMark({ nowMs: 0, still: true }))
    const b = markText(renderMark({ nowMs: 987_654, still: true }))
    expect(b).toBe(a)
    expect(a.replace(/[\s\n]/g, "").length).toBeGreaterThan(0)
  })

  test("the animated frame advances with the injected clock", () => {
    const frames = [0, 400, 900, 1500, 2400, 3200].map((nowMs) =>
      markText(renderMark({ nowMs, still: false })),
    )
    expect(new Set(frames).size).toBeGreaterThan(1)
  })

  test("the outline reveals left to right", () => {
    // Early in the draw phase only the leftmost columns may be lit.
    const grid = renderMark({ nowMs: 0.06 * MARK_PERIOD_SECONDS * 1000, still: false })
    const lit = grid.flatMap((row) =>
      row.flatMap((cell, col) => (cell.char === " " ? [] : [col])),
    )
    expect(Math.max(...lit, -1)).toBeLessThan(MARK_COLS)
    const full = renderMark({ nowMs: 0.4 * MARK_PERIOD_SECONDS * 1000, still: false })
    expect(emptyCells(grid)).toBeGreaterThan(emptyCells(full))
  })

  test("the fade thins the mark out toward empty", () => {
    const held = renderMark({ nowMs: 0.8 * MARK_PERIOD_SECONDS * 1000, still: false })
    const fading = renderMark({
      nowMs: 0.995 * MARK_PERIOD_SECONDS * 1000,
      still: false,
    })
    expect(emptyCells(fading)).toBeGreaterThan(emptyCells(held))
  })

  test("filling makes the mark denser than its outline alone", () => {
    const weight = (grid: readonly (readonly { char: string }[])[]): number =>
      grid.flat().reduce((sum, cell) => sum + " ░▒▓█".indexOf(cell.char), 0)
    const outlineOnly = renderMark({
      nowMs: 0.42 * MARK_PERIOD_SECONDS * 1000,
      still: false,
    })
    const filled = renderMark({
      nowMs: 0.8 * MARK_PERIOD_SECONDS * 1000,
      still: false,
    })
    expect(weight(filled)).toBeGreaterThan(weight(outlineOnly))
  })
})
