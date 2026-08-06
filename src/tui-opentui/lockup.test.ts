import { describe, expect, test } from "bun:test"

import {
  LOCKUP_FADE_MS,
  LOCKUP_WORDMARK,
  lockupCells,
  lockupText,
  lockupWidth,
} from "./lockup"
import { UI } from "./theme"

const still = (nowMs = 0) => lockupCells({ nowMs, still: true })

describe("brand lockup", () => {
  test("idle is the wordmark alone", () => {
    const cells = still()
    expect(cells).toHaveLength(lockupWidth(null))
    expect(lockupText(cells)).toBe(LOCKUP_WORDMARK)
    // The mountain lives on the landing; one row cannot hold a silhouette.
    expect(lockupText(cells)).not.toMatch(/[▁▂▃▄▅▆▇█]/)
  })

  test("idle is genuinely still", () => {
    const a = still(0)
    const b = still(9_000)
    expect(lockupText(b)).toBe(lockupText(a))
    expect(b.map((cell) => cell.fg)).toEqual(a.map((cell) => cell.fg))
  })

  test("a live turn swaps the wordmark for the phase", () => {
    const cells = lockupCells({ nowMs: 0, still: false, phase: "thinking" })
    expect(lockupText(cells)).toBe("thinking")
    expect(lockupWidth("thinking")).toBe(cells.length)
  })

  test("the wordmark stays chrome-dim", () => {
    for (const cell of still()) {
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
    expect(tone(LOCKUP_FADE_MS / 2)).toBe(UI.textDim)
    expect(tone(LOCKUP_FADE_MS)).toBe(UI.text)
    // Every cell rides the one ramp together.
    const last = (elapsed: number) => at(elapsed).at(-1)?.fg
    expect(last(0)).toBe(UI.textFaint)
    expect(last(LOCKUP_FADE_MS)).toBe(UI.text)
    // The word never changes mid-fade: only the tone moves.
    expect(lockupText(at(0))).toBe(lockupText(at(LOCKUP_FADE_MS)))
  })
})
