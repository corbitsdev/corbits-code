/**
 * The density ramp is the activity primitive. Every assertion here reads the
 * rendered frame and is pinned to the prompt box's bottom border — the one row
 * the status slot rides. Shell fields are not evidence: the bug this indicator
 * exists to fix was a slot whose internal state was perfectly correct and whose
 * painted row never changed.
 */

import { describe, expect, test } from "bun:test"

import { withTestRenderer } from "./harness"
import {
  RAMP_CYCLE_MS,
  STALL_BLINK_BURST_MS,
  STALL_BLINK_CYCLE_MS,
} from "./ramp"
import { attachSessionBridge, createRecordingPort } from "./runtime-bridge"
import { createAppShell } from "./shell"
import { UI } from "./theme"

const BRAILLE = /[⠀-⣿]/
const DENSITY = /[░▒▓█]/

/** Drives the bridge monitor tick by hand so the ramp animates deterministically. */
function fakeMonitor(stall?: {
  readonly noticeMs: number
  readonly timeoutMs: number
}): {
  readonly monitor: {
    now: () => number
    tickMs: number
    schedule: (tick: () => void, intervalMs: number) => () => void
    stallNoticeMs?: number
    stallTimeoutMs?: number
  }
  advance: (ms: number) => void
} {
  let clock = 0
  let ticker: (() => void) | null = null
  return {
    monitor: {
      now: () => clock,
      tickMs: 250,
      schedule: (tick) => {
        ticker = tick
        return () => {
          ticker = null
        }
      },
      ...(stall === undefined
        ? {}
        : { stallNoticeMs: stall.noticeMs, stallTimeoutMs: stall.timeoutMs }),
    },
    advance: (ms) => {
      clock += ms
      ticker?.()
    },
  }
}

/** The prompt box's bottom border — the row the status slot rides. */
function statusRow(frame: string): string {
  const row = frame.split("\n").find((line) => line.includes("╰"))
  if (row === undefined) throw new Error("no prompt-box bottom border in frame")
  return row
}

/**
 * The status slot's single state cell: the first glyph after the border's
 * opening corner and rule. Pinning to it is what keeps these assertions honest
 * — a bang or a block elsewhere in the frame must not satisfy them.
 */
function slotGlyph(frame: string): string {
  const match = /╰─ (\S)/.exec(statusRow(frame))
  if (match?.[1] === undefined) throw new Error("no status slot in border row")
  return match[1]
}

describe("turn ramp paint", () => {
  test("a running turn names its phase in the border, never a braille spinner", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        })
        const { monitor } = fakeMonitor()
        const bridge = attachSessionBridge(shell, createRecordingPort(), monitor)
        try {
          bridge.handle({ type: "run", state: "busy" })
          await h.renderOnce()

          const frame = h.captureCharFrame()
          expect(statusRow(frame)).toContain("working")
          expect(slotGlyph(frame)).toMatch(DENSITY)
          expect(frame).not.toMatch(BRAILLE)
        } finally {
          bridge.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("the working slot moves off the monitor tick, with no timer of its own", async () => {
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
          bridge.handle({ type: "run", state: "busy" })
          await h.renderOnce()
          const first = statusRow(h.captureCharFrame())
          advance(RAMP_CYCLE_MS / 4)
          await h.renderOnce()
          const second = statusRow(h.captureCharFrame())
          // The whole point of the indicator: a live run does not look hung.
          expect(second).not.toBe(first)
          expect(slotGlyph(second)).toMatch(DENSITY)
        } finally {
          bridge.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("an idle turn clears the slot back to the wordmark", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        })
        const { monitor } = fakeMonitor()
        const bridge = attachSessionBridge(shell, createRecordingPort(), monitor)
        try {
          bridge.handle({ type: "run", state: "busy" })
          bridge.handle({ type: "run", state: "idle" })
          await h.renderOnce()
          const row = statusRow(h.captureCharFrame())
          expect(row).not.toContain("working")
          expect(row).not.toMatch(DENSITY)
        } finally {
          bridge.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("idle costs zero animation frames — the tick does not re-arm", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        })
        let scheduleCalls = 0
        const { monitor, advance } = fakeMonitor()
        const countingMonitor = {
          ...monitor,
          schedule: (tick: () => void, ms: number) => {
            scheduleCalls++
            return monitor.schedule(tick, ms)
          },
        }
        const bridge = attachSessionBridge(
          shell,
          createRecordingPort(),
          countingMonitor,
        )
        try {
          bridge.handle({ type: "run", state: "busy" })
          bridge.handle({ type: "run", state: "idle" })
          const callsAtIdle = scheduleCalls
          advance(10_000)
          expect(scheduleCalls).toBe(callsAtIdle)
        } finally {
          bridge.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("working and blocked read apart in the border with no colour at all", async () => {
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
          bridge.handle({ type: "run", state: "busy" })
          await h.renderOnce()
          const workingGlyphs = new Set<string>()
          for (let i = 0; i < 4; i++) {
            workingGlyphs.add(slotGlyph(h.captureCharFrame()))
            advance(RAMP_CYCLE_MS / 4)
            await h.renderOnce()
          }
          // Moving: the cell is not the same glyph frame to frame.
          expect(workingGlyphs.size).toBeGreaterThan(1)

          bridge.gateOpened()
          await h.renderOnce()
          const blockedGlyph = slotGlyph(h.captureCharFrame())
          // Waiting: a glyph the moving state never paints, held still.
          expect(workingGlyphs.has(blockedGlyph)).toBe(false)
          const blockedRow = statusRow(h.captureCharFrame())
          advance(4_000)
          await h.renderOnce()
          expect(statusRow(h.captureCharFrame())).toBe(blockedRow)
        } finally {
          bridge.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("a stalled turn blinks a bang into the border, then settles to a static one", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        })
        const { monitor, advance } = fakeMonitor({
          noticeMs: 1_000,
          timeoutMs: 600_000,
        })
        const bridge = attachSessionBridge(shell, createRecordingPort(), monitor)
        try {
          bridge.handle({ type: "run", state: "busy" })
          await h.renderOnce()
          expect(slotGlyph(h.captureCharFrame())).toMatch(DENSITY)

          advance(1_500)
          await h.renderOnce()
          // Scoped to the slot: a bang anywhere else in the frame is not this.
          const blinking = new Set<string>()
          for (let i = 0; i < 4; i++) {
            blinking.add(slotGlyph(h.captureCharFrame()))
            advance(STALL_BLINK_CYCLE_MS / 2)
            await h.renderOnce()
          }
          expect(blinking.has("!")).toBe(true)
          expect(blinking.size).toBeGreaterThan(1)

          // Past the burst the alarm stops strobing but still reads as one.
          advance(STALL_BLINK_BURST_MS * 2)
          await h.renderOnce()
          const settled = statusRow(h.captureCharFrame())
          expect(slotGlyph(settled)).toBe("!")
          advance(STALL_BLINK_CYCLE_MS / 2)
          await h.renderOnce()
          expect(statusRow(h.captureCharFrame())).toBe(settled)
        } finally {
          bridge.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })
})

describe("palette", () => {
  test("no gray sits on the ground — every tone keeps a warm bias", () => {
    for (const [role, hex] of Object.entries(UI)) {
      if (role === "name") continue
      const r = Number.parseInt(hex.slice(1, 3), 16)
      const b = Number.parseInt(hex.slice(5, 7), 16)
      expect(r).toBeGreaterThan(b)
    }
  })

  test("chrome stays below the action orange so orange still reads as an event", () => {
    const action = saturation(UI.action)
    for (const hex of [UI.inFlight, UI.inFlightBright, UI.heading]) {
      expect(saturation(hex)).toBeLessThan(action)
    }
  })
})

/** HSL saturation, 0..1 — the axis the chrome ramp is held below action orange on. */
function saturation(hex: string): number {
  const channels = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
  const max = Math.max(...channels)
  const min = Math.min(...channels)
  if (max === min) return 0
  const lightness = (max + min) / 2
  return (max - min) / (lightness > 0.5 ? 2 - max - min : max + min)
}
