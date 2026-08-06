import { describe, expect, test } from "bun:test"

import {
  LOCKUP_FADE_MS,
  LOCKUP_MARK,
  LOCKUP_MARK_COLS,
  LOCKUP_WORDMARK,
  lockupCells,
  lockupText,
  lockupWidth,
} from "./lockup"
import { UI } from "./theme"

const still = (nowMs = 0) => lockupCells({ nowMs, still: true })

describe("brand lockup", () => {
  test("idle is the token peak followed by the wordmark", () => {
    const cells = still()
    expect(cells).toHaveLength(lockupWidth(null))
    expect(lockupText(cells)).toBe(`${LOCKUP_MARK} ${LOCKUP_WORDMARK}`)
    expect(LOCKUP_MARK).toHaveLength(LOCKUP_MARK_COLS)
    // A peak, not a bar: the summit is taller than either toe.
    const heights = [...LOCKUP_MARK].map((char) => " ▁▂▃▄▅▆▇█".indexOf(char))
    const summit = heights[1] ?? 0
    expect(Math.max(...heights)).toBe(summit)
    expect(summit).toBeGreaterThan(Math.max(heights[0] ?? 0, heights[2] ?? 0))
  })

  test("idle is genuinely still", () => {
    const a = still(0)
    const b = still(9_000)
    expect(lockupText(b)).toBe(lockupText(a))
    expect(b.map((cell) => cell.fg)).toEqual(a.map((cell) => cell.fg))
  })

  test("a live turn swaps the wordmark for the phase", () => {
    const cells = lockupCells({ nowMs: 0, still: false, phase: "thinking" })
    expect(lockupText(cells)).toBe(`${LOCKUP_MARK} thinking`)
    expect(lockupWidth("thinking")).toBe(cells.length)
  })

  test("the wordmark stays chrome-dim and the mark keeps the brand tone", () => {
    const cells = still()
    for (const cell of cells.slice(0, LOCKUP_MARK_COLS)) {
      expect(cell.fg).toBe(UI.action)
    }
    for (const cell of cells.slice(LOCKUP_MARK_COLS)) {
      expect(cell.fg).toBe(UI.textDim)
    }
  })

  test("a state change fades in through the warm dim tones", () => {
    const at = (elapsed: number) =>
      lockupCells({
        nowMs: elapsed,
        still: false,
        phase: "bash",
        changedMs: 0,
      })
    const tone = (elapsed: number) => at(elapsed)[0]?.fg
    expect(tone(0)).toBe(UI.textFaint)
    expect(tone(LOCKUP_FADE_MS / 2)).toBe(UI.actionDim)
    expect(tone(LOCKUP_FADE_MS)).toBe(UI.action)
    // The text rides the same transition, one tier brighter at rest.
    const last = (elapsed: number) => at(elapsed).at(-1)?.fg
    expect(last(0)).toBe(UI.textFaint)
    expect(last(LOCKUP_FADE_MS)).toBe(UI.text)
    // The glyph never deforms: only the tone moves.
    expect(lockupText(at(0))).toBe(lockupText(at(LOCKUP_FADE_MS)))
  })
})
