/**
 * Live reasoning reveals text at a bounded rate into a short wrapped preview,
 * so a fast model still reads at human pace without sideways-scrolling one
 * line. Pure-function coverage lives here; `advanceOpenReveal`'s wiring
 * through the bridge is covered by the bridge/tick tests below.
 */

import { describe, expect, test } from "bun:test"

import { advanceRevealChars, thinkingLivePreviewLines } from "./thinking"
import { withTestRenderer } from "./harness"
import { attachSessionBridge, createRecordingPort } from "./runtime-bridge"
import { createAppShell } from "./shell"

function fakeMonitor(): {
  readonly monitor: {
    now: () => number
    tickMs: number
    schedule: (tick: () => void, intervalMs: number) => () => void
  }
  advance: (ms: number) => void
} {
  let clock = 0
  let ticker: (() => void) | null = null
  return {
    monitor: {
      now: () => clock,
      tickMs: 80,
      schedule: (tick) => {
        ticker = tick
        return () => {
          ticker = null
        }
      },
    },
    advance: (ms) => {
      clock += ms
      ticker?.()
    },
  }
}

describe("advanceRevealChars", () => {
  test("advances at the bounded rate, never past what has arrived", () => {
    const revealed = advanceRevealChars(0, 1000, 1000, 28)
    expect(revealed).toBe(28)
  })

  test("caps at the available text even given unlimited time", () => {
    const revealed = advanceRevealChars(0, 10, 10_000, 28)
    expect(revealed).toBe(10)
  })

  test("does not regress when elapsed time is zero", () => {
    expect(advanceRevealChars(15, 40, 0, 28)).toBe(15)
  })

  test("clamps a stale reveal ahead of a shrunk available count", () => {
    expect(advanceRevealChars(50, 20, 100, 28)).toBe(20)
  })
})

describe("thinkingLivePreviewLines with a reveal position", () => {
  const text = "the quick brown fox jumps over the lazy dog and keeps running"

  test("shows nothing revealed as a single empty line", () => {
    expect(thinkingLivePreviewLines(text, 20, 0)).toEqual([""])
  })

  test("wraps only the revealed prefix", () => {
    const lines = thinkingLivePreviewLines(text, 10, 20)
    const painted = lines.join(" ")
    expect(painted.length).toBeGreaterThan(0)
    expect(lines.every((line) => line.length <= 10)).toBe(true)
    // Soft-wrap may drop break spaces, but nothing past the reveal may appear.
    expect(painted).not.toContain("jumps")
  })

  test("never shows text past the reveal position even though more has arrived", () => {
    const painted = thinkingLivePreviewLines(text, 10, 15).join(" ")
    expect(painted).not.toContain("fox")
  })

  test("omitting revealChars wraps whatever has arrived, capped to max lines", () => {
    const lines = thinkingLivePreviewLines(text, 10)
    expect(lines.length).toBeLessThanOrEqual(3)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every((line) => line.length <= 10)).toBe(true)
    expect(lines.join(" ")).toContain("running")
  })

  test("sample frames across a few rates, printed for eyeballing", () => {
    const sample = "we need to check whether the cache key already accounts for the locale"
    for (const rate of [15, 20, 28, 40, 60]) {
      const frames = [200, 500, 1000, 1500].map((ms) => {
        const chars = advanceRevealChars(0, sample.length, ms, rate)
        return thinkingLivePreviewLines(sample, 30, chars)
      })
      // eslint-disable-next-line no-console
      console.log(`rate=${rate}/s`, frames)
    }
    expect(true).toBe(true)
  })
})

describe("the reveal position through the bridge", () => {
  test("a stalled stream stalls the line instead of showing blanks", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        })
        const { monitor, advance } = fakeMonitor()
        const bridge = attachSessionBridge(shell, createRecordingPort(), monitor)
        try {
          bridge.handle({ type: "inference.start", data: {} })
          bridge.handle({
            type: "inference.thinking.delta",
            data: { token: "short thought" },
          })
          advance(80)
          const first = shell.streamLog.at(-1)
          advance(80)
          const second = shell.streamLog.at(-1)
          // Text is short enough to fully reveal quickly; once it has, further
          // ticks with no new delta must not change the painted row.
          advance(5_000)
          const third = shell.streamLog.at(-1)
          expect(first?.text).toBe("short thought")
          expect(second?.text).toBe(third?.text)
        } finally {
          bridge.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("a burst of text does not jump the window ahead of the bounded rate", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        })
        const { monitor, advance } = fakeMonitor()
        const bridge = attachSessionBridge(shell, createRecordingPort(), monitor)
        try {
          bridge.handle({ type: "inference.start", data: {} })
          const long = "x".repeat(500)
          bridge.handle({
            type: "inference.thinking.delta",
            data: { token: long },
          })
          advance(80)
          const row = shell.streamLog.at(-1)
          expect(row?.revealChars).toBeDefined()
          expect(row?.revealChars ?? 0).toBeLessThan(500)
        } finally {
          bridge.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("the row still settles to its phrase once reasoning closes, even mid-reveal", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        })
        const { monitor, advance } = fakeMonitor()
        const bridge = attachSessionBridge(shell, createRecordingPort(), monitor)
        try {
          bridge.handle({ type: "inference.start", data: {} })
          const long = "x".repeat(500)
          bridge.handle({
            type: "inference.thinking.delta",
            data: { token: long },
          })
          advance(80)
          bridge.handle({
            type: "inference.text.delta",
            data: { token: "answer" },
          })
          const thinkingRow = shell.streamLog.find((r) => r.meta === "thinking")
          expect(thinkingRow?.thought).toBeDefined()
          expect(thinkingRow?.streaming).not.toBe(true)
        } finally {
          bridge.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })
})
