/**
 * Bridge-level wiring for the progress label, quota auto-retry and stall
 * watchdog. The monitor clock is injected, so nothing here waits on wall time.
 */

import { describe, expect, test } from "bun:test"

import { attachSessionBridge, createRecordingPort } from "./runtime-bridge.js"
import { createAppShell } from "./shell.js"
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

/** The status row holds a StyledText; join its chunks for assertions. */
function statusText(shell: { status: { content: unknown } }): string {
  const content = shell.status.content
  if (typeof content === "string") return content
  const { chunks } = content as { chunks?: readonly { text?: string }[] }
  return (chunks ?? []).map((c) => c.text ?? "").join("")
}

const quotaEvent = (retryAfterMs: number) => ({
  type: "inference.error",
  data: { error: { category: "quota_exhausted", retryAfterMs } },
})

describe("turn progress label", () => {
  test("tracks the live phase and clears when the run settles", async () => {
    await withTestRenderer(async (h) => {
      const t: Harness = await setup(h)
      try {
        expect(t.shell.turnPhase).toBeNull()

        t.bridge.handle({ type: "inference.start", data: {} })
        expect(t.shell.turnPhase).toBe("Working…")

        t.bridge.handle({
          type: "inference.thinking.delta",
          data: { token: "hm" },
        })
        expect(t.shell.turnPhase).toBe("Thinking…")

        t.bridge.handle({ type: "inference.text.delta", data: { token: "hi" } })
        expect(t.shell.turnPhase).toBe("Responding…")

        t.bridge.handle({
          type: "inference.tool_call.end",
          data: { name: "bash", callId: "c1" },
        })
        expect(t.shell.turnPhase).toBe("Running tool…")

        t.bridge.handle({ type: "reactor.done", data: {} })
        expect(t.shell.turnPhase).toBeNull()
      } finally {
        t.bridge.dispose()
      }
    })
  })

  test("an open permission overlay shows the approval wait", async () => {
    await withTestRenderer(async (h) => {
      const t: Harness = await setup(h)
      try {
        t.bridge.handle({ type: "inference.start", data: {} })
        t.shell.overlayKind = "permissions"
        t.tick()
        expect(t.shell.turnPhase).toBe("Waiting for approval…")
        expect(statusText(t.shell)).toContain("Waiting for approval…")
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
