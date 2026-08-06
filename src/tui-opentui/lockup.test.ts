import { describe, expect, test } from "bun:test"

import {
  LOCKUP_MARK_COLS,
  LOCKUP_WIDTH,
  LOCKUP_WORDMARK,
  lockupCells,
  lockupText,
} from "./lockup"
import { MARK_PERIOD_SECONDS } from "./mark-anim"
import { UI } from "./theme"

const still = (nowMs = 0) => lockupCells({ nowMs, still: true })

describe("brand lockup", () => {
  test("is a ridge glyph followed by the wordmark", () => {
    const cells = still()
    expect(cells).toHaveLength(LOCKUP_WIDTH)
    expect(lockupText(cells)).toEndWith(` ${LOCKUP_WORDMARK}`)
    expect(lockupText(cells.slice(0, LOCKUP_MARK_COLS)).trim()).not.toBe("")
  })

  test("the settled frame is the full ridgeline and does not move", () => {
    const a = lockupText(still(0))
    const b = lockupText(still(9_000))
    expect(a).toBe(b)
    // A mountain, not a bar: the peak is taller than the flanks.
    const ridge = a.slice(0, LOCKUP_MARK_COLS)
    expect(new Set(ridge).size).toBeGreaterThan(1)
  })

  test("the wordmark stays chrome-dim and the mark keeps the brand tone", () => {
    const cells = still()
    for (const cell of cells.slice(0, LOCKUP_MARK_COLS)) {
      expect([UI.action, UI.actionDim] as readonly string[]).toContain(cell.fg)
    }
    for (const cell of cells.slice(LOCKUP_MARK_COLS)) {
      expect(cell.fg).toBe(UI.textDim)
    }
  })

  test("animating frames differ across the timeline", () => {
    const frames = new Set<string>()
    for (let i = 0; i < 12; i++) {
      const nowMs = (MARK_PERIOD_SECONDS * 1000 * i) / 12
      frames.add(lockupText(lockupCells({ nowMs, still: false })))
    }
    expect(frames.size).toBeGreaterThan(2)
  })
})
