import { describe, expect, test } from "bun:test"

import {
  PROMPT_BASE_ROWS,
  PROMPT_BORDER_ROWS,
  PROMPT_CAP_FRACTION,
  PROMPT_IDLE_INPUT_ROWS,
  PROMPT_IDLE_ROWS,
} from "./geometry/index.js"
import {
  promptBoxCapRows,
  promptBoxRows,
  promptInputRows,
  promptIsScrolling,
} from "./prompt-rows.js"

describe("prompt box sizing", () => {
  test("an empty prompt still offers a composing area", () => {
    for (const rows of [24, 30, 40, 60]) {
      expect(promptInputRows(0, rows)).toBe(PROMPT_IDLE_INPUT_ROWS)
      expect(promptBoxRows(1, rows)).toBe(PROMPT_IDLE_ROWS)
    }
  })

  test("the box grows a row per wrapped line past the resting size", () => {
    expect(promptInputRows(4, 40)).toBe(4)
    expect(promptInputRows(7, 40)).toBe(7)
    expect(promptBoxRows(7, 40)).toBe(9)
  })

  test("growth stops at the cap fraction of the terminal", () => {
    for (const rows of [24, 30, 40, 60, 120]) {
      const cap = Math.floor(rows * PROMPT_CAP_FRACTION)
      expect(promptBoxRows(1000, rows)).toBe(cap)
      expect(promptBoxRows(1000, rows)).toBe(promptBoxCapRows(rows))
    }
  })

  test("content past the cap scrolls inside the box instead of growing it", () => {
    const rows = 24
    const cap = promptBoxCapRows(rows) - PROMPT_BORDER_ROWS
    expect(promptIsScrolling(cap, rows)).toBe(false)
    expect(promptIsScrolling(cap + 1, rows)).toBe(true)
    expect(promptInputRows(cap + 50, rows)).toBe(cap)
  })

  test("a very short terminal falls back to the base box, never below it", () => {
    for (const rows of [4, 6, 8, 10]) {
      expect(promptBoxRows(0, rows)).toBeGreaterThanOrEqual(PROMPT_BASE_ROWS)
      expect(promptBoxRows(50, rows)).toBeGreaterThanOrEqual(PROMPT_BASE_ROWS)
    }
    expect(promptBoxRows(50, 6)).toBe(PROMPT_BASE_ROWS)
  })
})
