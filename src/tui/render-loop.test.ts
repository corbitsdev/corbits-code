/**
 * Render-loop guard rails.
 *
 * The monitor is the only clock the TUI animates off, so two properties have to
 * hold: it must stop when nothing is moving, and a plain appended transcript row
 * must not cost a rebuild of the rows already on screen.
 */

import { describe, expect, test } from "bun:test"

import { withTestRenderer } from "./harness"
import { RAMP_CYCLE_MS, rampPulse } from "./ramp"
import { attachSessionBridge, createRecordingPort } from "./runtime-bridge"
import { appendStreamRow, createAppShell } from "./shell"

const SHELL_OPTS = {
  terminal: { columns: 80, rows: 24 },
  wireKeys: false,
  run: "idle",
} as const

const WIDE = { width: 80, height: 24 } as const

type ScheduleCall = { readonly intervalMs: number }

/** Records every (re)scheduling of the monitor and lets the test drive it. */
function recordingMonitor() {
  let clock = 0
  let ticker: (() => void) | null = null
  const schedules: ScheduleCall[] = []
  return {
    monitor: {
      now: () => clock,
      schedule: (tick: () => void, intervalMs: number) => {
        schedules.push({ intervalMs })
        ticker = tick
        return () => {
          ticker = null
        }
      },
    },
    schedules,
    running: () => ticker !== null,
    intervalMs: () => schedules.at(-1)?.intervalMs ?? null,
    advance: (ms: number) => {
      clock += ms
      ticker?.()
    },
  }
}

describe("monitor cadence", () => {
  test("stays quiet while the session is idle", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, SHELL_OPTS)
      const m = recordingMonitor()
      const bridge = attachSessionBridge(shell, createRecordingPort(), m.monitor)
      try {
        // Attaching to an idle session must not start a repaint loop.
        expect(m.running()).toBe(false)
        expect(m.schedules).toEqual([])

        bridge.handle({ type: "run", state: "busy" })
        expect(m.running()).toBe(true)

        bridge.handle({ type: "reactor.done", data: {} })
        expect(shell.lockupPhase).toBeNull()
        expect(m.running()).toBe(false)
      } finally {
        bridge.dispose()
      }
    }, WIDE)
  })

  test("animates fast enough for the ramp to read as motion", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, SHELL_OPTS)
      const m = recordingMonitor()
      const bridge = attachSessionBridge(shell, createRecordingPort(), m.monitor)
      try {
        bridge.handle({ type: "run", state: "busy" })
        const tickMs = m.intervalMs()
        expect(tickMs).not.toBeNull()

        // The comet crosses width + feather cells per cycle; a cadence that
        // samples fewer times than that jumps cells instead of travelling.
        expect(RAMP_CYCLE_MS / (tickMs ?? 1)).toBeGreaterThanOrEqual(14)

        // Every step the status slot's pulse has must actually get sampled;
        // a cadence that skips steps turns the cycle into a stutter.
        const glyphs = new Set<string>()
        for (let elapsed = 0; elapsed < RAMP_CYCLE_MS; elapsed += tickMs ?? 1) {
          m.advance(tickMs ?? 1)
          glyphs.add(
            rampPulse({
              phase: "working",
              nowMs: shell.lockupNowMs,
              stalledForMs: null,
            }),
          )
        }
        expect(glyphs.size).toBeGreaterThanOrEqual(4)
      } finally {
        bridge.dispose()
      }
    }, WIDE)
  })
})

describe("transcript append", () => {
  test("a plain appended row keeps the rows already painted", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, SHELL_OPTS)
      for (const text of ["one", "two", "three"]) {
        appendStreamRow(shell, { role: "system", text })
      }
      // Index 0 is the transcript's bottom-anchor spacer, not a row.
      const before = shell.transcript.getChildren().slice(1)
      expect(before).toHaveLength(3)

      appendStreamRow(shell, { role: "system", text: "four" })

      const after = shell.transcript.getChildren().slice(1)
      expect(after).toHaveLength(4)
      // Same node objects: the append added one renderable rather than tearing
      // the window down and rebuilding every row.
      expect(after.slice(0, 3)).toEqual(before)
    }, WIDE)
  })
})
