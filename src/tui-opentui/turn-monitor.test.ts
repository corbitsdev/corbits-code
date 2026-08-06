/**
 * Bridge-level wiring for the progress label, quota auto-retry and stall
 * watchdog. The monitor clock is injected, so nothing here waits on wall time.
 */

import { describe, expect, test } from "bun:test"

import { attachSessionBridge, createRecordingPort } from "./runtime-bridge.js"
import { createAppShell, noticeText } from "./shell.js"
import { withTestRenderer } from "./harness.js"
import { STALL_RECOVERY_MESSAGE } from "./stall-watchdog.js"

type Harness = Awaited<ReturnType<typeof setup>>

async function setup(h: { renderer: Parameters<typeof createAppShell>[0] }) {
  const shell = createAppShell(h.renderer, {
    terminal: { columns: 80, rows: 24 },
    wireKeys: false,
    run: "idle",
  })
  const port = createRecordingPort()
  let nowMs = 0
  let tick: (() => void) | undefined
  const bridge = attachSessionBridge(shell, port, {
    now: () => nowMs,
    stallTimeoutMs: 1_000,
    schedule: (fn) => {
      tick = fn
      return () => {
        tick = undefined
      }
    },
  })
  return {
    shell,
    port,
    bridge,
    advance: (ms: number) => {
      nowMs += ms
    },
    tick: () => tick?.(),
  }
}

const quotaEvent = (retryAfterMs: number) => ({
  type: "inference.error",
  data: { error: { category: "quota_exhausted", retryAfterMs } },
})

const RAMP = /[░▒▓█]/

describe("turn progress label", () => {
  test("tracks the live phase and clears when the run settles", async () => {
    await withTestRenderer(async (h) => {
      const t: Harness = await setup(h)
      try {
        expect(t.shell.turnPhase).toBeNull()

        t.bridge.handle({ type: "inference.start", data: {} })
        expect(t.shell.turnPhase).toMatch(RAMP)
        expect(t.shell.turnPhase).toEndWith("working")

        t.bridge.handle({
          type: "inference.thinking.delta",
          data: { token: "hm" },
        })
        expect(t.shell.turnPhase).toEndWith("thinking")

        t.bridge.handle({ type: "inference.text.delta", data: { token: "hi" } })
        expect(t.shell.turnPhase).toEndWith("streaming 1 tok")

        t.bridge.handle({ type: "inference.text.delta", data: { token: " there" } })
        expect(t.shell.turnPhase).toEndWith("streaming 2 tok")

        t.bridge.handle({
          type: "inference.tool_call.end",
          data: { name: "bash", callId: "c1" },
        })
        expect(t.shell.turnPhase).toEndWith("bash")

        t.bridge.handle({ type: "reactor.done", data: {} })
        expect(t.shell.turnPhase).toBeNull()
      } finally {
        t.bridge.dispose()
      }
    })
  })

  test("the bottom-left slot carries the phase and fades on each change", async () => {
    await withTestRenderer(async (h) => {
      const t: Harness = await setup(h)
      try {
        expect(t.shell.lockupPhase).toBeNull()

        t.bridge.handle({ type: "inference.start", data: {} })
        expect(t.shell.lockupPhase).toBe("working")
        const started = t.shell.lockupChangedMs

        t.advance(500)
        t.bridge.handle({
          type: "inference.thinking.delta",
          data: { token: "hm" },
        })
        expect(t.shell.lockupPhase).toBe("thinking")
        // A new phase restamps the fade so the crossfade starts over.
        expect(t.shell.lockupChangedMs).toBeGreaterThan(started)

        t.bridge.handle({ type: "reactor.done", data: {} })
        expect(t.shell.lockupPhase).toBeNull()
      } finally {
        t.bridge.dispose()
      }
    })
  })

  /**
   * The shape a real chat turn actually has. A chat session emits no
   * `reactor.done` until it closes, so `connector.reply` is the only terminal
   * event the shell ever sees — the regression this covers left the phase line
   * counting for the rest of the session.
   */
  test("a full turn with a tool clears the phase on connector.reply", async () => {
    await withTestRenderer(async (h) => {
      const t: Harness = await setup(h)
      try {
        t.bridge.handle({
          type: "message.received",
          data: { message: { content: "list the root" } },
        })
        t.bridge.handle({ type: "inference.start", data: {} })
        t.bridge.handle({ type: "inference.text.delta", data: { token: "I'll " } })
        t.bridge.handle({ type: "inference.text.delta", data: { token: "look." } })
        t.bridge.handle({
          type: "inference.tool_call.start",
          data: { name: "bash", callId: "c1" },
        })
        t.bridge.handle({
          type: "inference.tool_call.end",
          data: { name: "bash", callId: "c1", arguments: "ls" },
        })
        t.bridge.handle({ type: "inference.done", data: {} })

        // The cycle's reply lands while bash is still out: the turn continues.
        t.bridge.handle({ type: "connector.reply", data: { content: "" } })
        expect(t.shell.turnPhase).not.toBeNull()

        t.bridge.handle({
          type: "tool.start",
          data: { call: { id: "c1", name: "bash" } },
        })
        t.bridge.handle({
          type: "tool.done",
          data: { result: { callId: "c1", name: "bash", content: "AGENTS.md" } },
        })

        t.bridge.handle({ type: "inference.start", data: {} })
        t.bridge.handle({ type: "inference.text.delta", data: { token: "done." } })
        t.bridge.handle({ type: "inference.done", data: {} })
        t.bridge.handle({ type: "connector.reply", data: { content: "done." } })

        expect(t.shell.turnPhase).toBeNull()
        expect(t.bridge.turn.isProcessing).toBe(false)
        expect(noticeText(t.shell)).not.toContain("working")
        // The session is handed back and the transient row empties with it.
        expect(t.shell.session.run).toBe("idle")
        expect(noticeText(t.shell)).toBe("")

        // A later tick must not resurrect it.
        t.advance(250)
        t.tick()
        expect(t.shell.turnPhase).toBeNull()
      } finally {
        t.bridge.dispose()
      }
    })
  })

  test("an interrupted turn clears the phase", async () => {
    await withTestRenderer(async (h) => {
      const t: Harness = await setup(h)
      try {
        t.bridge.handle({ type: "inference.start", data: {} })
        t.bridge.handle({ type: "inference.text.delta", data: { token: "hi" } })
        expect(t.shell.turnPhase).not.toBeNull()

        t.bridge.interrupt()
        expect(t.shell.turnPhase).toBeNull()
        t.advance(250)
        t.tick()
        expect(t.shell.turnPhase).toBeNull()
      } finally {
        t.bridge.dispose()
      }
    })
  })

  test("a reactor error clears the phase", async () => {
    await withTestRenderer(async (h) => {
      const t: Harness = await setup(h)
      try {
        t.bridge.handle({ type: "inference.start", data: {} })
        t.bridge.handle({
          type: "inference.tool_call.end",
          data: { name: "bash", callId: "c1" },
        })
        expect(t.shell.turnPhase).not.toBeNull()

        t.bridge.handle({
          type: "reactor.error",
          data: { fatal: true, error: "boom" },
        })
        expect(t.shell.turnPhase).toBeNull()
        expect(t.bridge.turn.isProcessing).toBe(false)
      } finally {
        t.bridge.dispose()
      }
    })
  })

  test("an open permission overlay freezes the ramp and reads blocked", async () => {
    await withTestRenderer(async (h) => {
      const t: Harness = await setup(h)
      try {
        t.bridge.handle({ type: "inference.start", data: {} })
        t.shell.overlayKind = "permissions"
        t.tick()
        expect(t.shell.turnPhase).toEndWith("blocked")

        // Frozen is the signal: the ramp must not move while a human is asked.
        const frozen = t.shell.turnPhase
        t.advance(1_000)
        expect(t.shell.turnPhase).toBe(frozen)

        // The running state lives in the border, not the transient row: the
        // row would be a second indicator one line above the first.
        expect(noticeText(t.shell)).not.toContain("blocked")
        expect(noticeText(t.shell)).not.toMatch(/[░▒▓█]/u)
      } finally {
        t.bridge.dispose()
      }
    })
  })
})

describe("quota auto-retry", () => {
  test("counts down then resubmits the last prompt once", async () => {
    await withTestRenderer(async (h) => {
      const t: Harness = await setup(h)
      try {
        t.bridge.submit("run the build", "immediate")
        t.port.clear()
        t.bridge.handle(quotaEvent(60_000))

        t.advance(10_000)
        t.tick()
        expect(t.shell.statusFlash).toBe("rate limited — retrying in 50s")
        expect(t.port.calls).toEqual([])

        t.advance(60_000)
        t.tick()
        expect(t.port.calls).toEqual([
          { op: "sendImmediate", text: "run the build" },
        ])

        // Window is closed — a later tick must not replay the prompt again.
        t.advance(60_000)
        t.tick()
        expect(t.port.calls.filter((c) => c.op === "sendImmediate")).toHaveLength(
          1,
        )
      } finally {
        t.bridge.dispose()
      }
    })
  })

  test("an interrupted turn is never replayed", async () => {
    await withTestRenderer(async (h) => {
      const t: Harness = await setup(h)
      try {
        t.bridge.submit("run the build", "immediate")
        t.bridge.handle(quotaEvent(1_000))
        t.bridge.interrupt()
        t.port.clear()

        t.advance(10_000)
        t.tick()
        expect(t.port.calls).toEqual([])
      } finally {
        t.bridge.dispose()
      }
    })
  })
})

describe("stall watchdog", () => {
  test("aborts and flashes after the stall timeout", async () => {
    await withTestRenderer(async (h) => {
      const t: Harness = await setup(h)
      try {
        t.bridge.submit("build it", "immediate")
        t.port.clear()

        t.advance(500)
        t.tick()
        expect(t.port.calls).toEqual([])

        t.advance(1_000)
        t.tick()
        expect(t.port.calls).toEqual([{ op: "interrupt" }])
        expect(t.shell.statusFlash).toBe(STALL_RECOVERY_MESSAGE)

        // The aborted turn is settled, so the watchdog does not re-fire.
        t.advance(10_000)
        t.tick()
        expect(t.port.calls).toHaveLength(1)
      } finally {
        t.bridge.dispose()
      }
    })
  })

  test("a live tool run is not treated as a stall", async () => {
    await withTestRenderer(async (h) => {
      const t: Harness = await setup(h)
      try {
        t.bridge.submit("build it", "immediate")
        t.bridge.handle({ type: "inference.text.delta", data: { token: "ok" } })
        t.bridge.handle({
          type: "inference.tool_call.end",
          data: { name: "bash", callId: "c1" },
        })
        t.port.clear()

        t.advance(10_000)
        t.tick()
        expect(t.port.calls).toEqual([])
      } finally {
        t.bridge.dispose()
      }
    })
  })
})

describe("reasoning settles to a summary", () => {
  test("a closed thinking row carries its elapsed time and a fresh phrasing", async () => {
    await withTestRenderer(async (h) => {
      const t: Harness = await setup(h)
      try {
        for (const burst of [12_000, 12_000]) {
          t.bridge.handle({ type: "inference.start", data: {} })
          t.bridge.handle({
            type: "inference.thinking.delta",
            data: { token: "weighing the call sites" },
          })
          t.advance(burst)
          t.bridge.handle({ type: "inference.text.delta", data: { token: "done" } })
        }

        const thoughts = t.shell.streamLog
          .filter((row) => row.meta === "thinking")
          .map((row) => row.thought)
        expect(thoughts).toHaveLength(2)
        expect(thoughts[0]?.ms).toBe(12_000)
        // Two identical-length thoughts in one session must not read alike.
        expect(thoughts[0]?.variant).not.toBe(thoughts[1]?.variant)
      } finally {
        t.bridge.dispose()
      }
    })
  })

  test("a live thinking row stays open and unsettled", async () => {
    await withTestRenderer(async (h) => {
      const t: Harness = await setup(h)
      try {
        t.bridge.handle({ type: "inference.start", data: {} })
        t.bridge.handle({
          type: "inference.thinking.delta",
          data: { token: "still going" },
        })
        const live = t.shell.streamLog.find((row) => row.meta === "thinking")
        expect(live?.streaming).toBe(true)
        expect(live?.thought).toBeUndefined()
      } finally {
        t.bridge.dispose()
      }
    })
  })
})
