/**
 * The density ramp is the activity primitive: a running turn must paint block
 * glyphs, and no braille spinner may survive anywhere in the frame.
 */

import { describe, expect, test } from "bun:test"

import { withTestRenderer } from "./harness"
import { RAMP_CYCLE_MS } from "./ramp"
import { attachSessionBridge, createRecordingPort } from "./runtime-bridge"
import { createAppShell } from "./shell"
import { UI } from "./theme"

const BRAILLE = /[⠀-⣿]/
const DENSITY = /[░▒▓█]/

/** Drives the bridge monitor tick by hand so the ramp animates deterministically. */
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
      tickMs: 250,
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

describe("turn ramp paint", () => {
  test("a running turn names its phase, and never a braille spinner", async () => {
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

          // The border's bottom-left slot carries the running state as a
          // word. The ramp that used to sit beside it was a second animation
          // saying the same thing, and the context reading is a plain percent.
          expect(shell.turnPhase).not.toBeNull()
          expect(shell.turnPhase).toContain("working")

          const frame = h.captureCharFrame()
          expect(frame).toContain("working")
          expect(frame).not.toMatch(BRAILLE)
        } finally {
          bridge.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("the ramp animates off the monitor tick, with no timer of its own", async () => {
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
          const first = shell.turnPhase
          advance(RAMP_CYCLE_MS / 2)
          expect(shell.turnPhase).not.toBe(first)
          expect(shell.turnPhase).toMatch(DENSITY)
        } finally {
          bridge.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("an idle turn clears the ramp entirely", async () => {
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
          expect(shell.turnPhase).toBeNull()
        } finally {
          bridge.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })
})

describe("palette", () => {
  test("no gray sits on black — dim tones keep a warm bias", () => {
    for (const hex of [UI.text, UI.textDim, UI.textFaint]) {
      const r = Number.parseInt(hex.slice(1, 3), 16)
      const b = Number.parseInt(hex.slice(5, 7), 16)
      expect(r).toBeGreaterThan(b)
    }
  })
})
