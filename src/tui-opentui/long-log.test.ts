import { describe, expect, test } from "bun:test"
import type { StreamRow } from "./stream"
import {
  LONG_LOG_COLLAPSE_THRESHOLD,
  LONG_LOG_WINDOW,
  collapseMarker,
  mustWindow,
  windowSlice,
} from "./long-log"

function rows(n: number): StreamRow[] {
  return Array.from({ length: n }, (_, i) => ({
    role: "assistant" as const,
    text: `line-${i}`,
  }))
}

describe("windowSlice", () => {
  test("empty log", () => {
    const w = windowSlice([])
    expect(w).toEqual({
      start: 0,
      end: 0,
      rows: [],
      truncatedAbove: false,
      truncatedBelow: false,
      total: 0,
    })
  })

  test("follow-tail keeps last windowSize rows", () => {
    const log = rows(50)
    const w = windowSlice(log, { windowSize: 10 })
    expect(w.start).toBe(40)
    expect(w.end).toBe(50)
    expect(w.rows).toHaveLength(10)
    expect(w.rows[0]?.text).toBe("line-40")
    expect(w.rows[9]?.text).toBe("line-49")
    expect(w.truncatedAbove).toBe(true)
    expect(w.truncatedBelow).toBe(false)
    expect(w.total).toBe(50)
  })

  test("short log is fully visible", () => {
    const log = rows(5)
    const w = windowSlice(log, { windowSize: 10 })
    expect(w.start).toBe(0)
    expect(w.end).toBe(5)
    expect(w.truncatedAbove).toBe(false)
    expect(w.truncatedBelow).toBe(false)
  })

  test("pinIndex keeps historical row in window", () => {
    const log = rows(100)
    const w = windowSlice(log, { windowSize: 10, pinIndex: 5 })
    expect(w.start).toBeLessThanOrEqual(5)
    expect(w.end).toBeGreaterThan(5)
    expect(w.rows.some((r) => r.text === "line-5")).toBe(true)
    expect(w.truncatedBelow).toBe(true)
  })

  test("pin at head", () => {
    const log = rows(100)
    const w = windowSlice(log, { windowSize: 10, pinIndex: 0 })
    expect(w.start).toBe(0)
    expect(w.rows[0]?.text).toBe("line-0")
    expect(w.truncatedAbove).toBe(false)
    expect(w.truncatedBelow).toBe(true)
  })

  test("pin at tail", () => {
    const log = rows(100)
    const w = windowSlice(log, { windowSize: 10, pinIndex: 99 })
    expect(w.end).toBe(100)
    expect(w.truncatedBelow).toBe(false)
  })
})

describe("mustWindow / budgets", () => {
  test("threshold and default window are positive", () => {
    expect(LONG_LOG_WINDOW).toBeGreaterThan(0)
    expect(LONG_LOG_COLLAPSE_THRESHOLD).toBeGreaterThan(LONG_LOG_WINDOW)
  })

  test("mustWindow flips at collapse threshold", () => {
    expect(mustWindow(LONG_LOG_COLLAPSE_THRESHOLD)).toBe(false)
    expect(mustWindow(LONG_LOG_COLLAPSE_THRESHOLD + 1)).toBe(true)
  })
})

describe("collapseMarker", () => {
  test("formats count", () => {
    expect(collapseMarker(0)).toBe("")
    expect(collapseMarker(1)).toBe("… 1 earlier line collapsed")
    expect(collapseMarker(42)).toBe("… 42 earlier lines collapsed")
  })
})

describe("long-log smoke scale", () => {
  test("multi-thousand slice is O(window) not O(total)", () => {
    const log = rows(5000)
    const t0 = performance.now()
    const w = windowSlice(log, { windowSize: LONG_LOG_WINDOW })
    const ms = performance.now() - t0
    expect(w.rows).toHaveLength(LONG_LOG_WINDOW)
    expect(w.truncatedAbove).toBe(true)
    expect(w.total).toBe(5000)
    // Pure slice should be well under a millisecond class budget on CI.
    expect(ms).toBeLessThan(50)
  })
})
