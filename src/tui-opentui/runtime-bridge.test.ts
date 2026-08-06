import { describe, expect, test } from "bun:test"
import {
  FIXTURE_BUSY_SESSION,
  attachSessionBridge,
  createRecordingPort,
  mapReactorLike,
} from "./runtime-bridge"
import { createAppShell } from "./shell"
import { withTestRenderer } from "./harness"
import { badgeCount } from "./session-queue"

describe("mapReactorLike", () => {
  test("message.received → user", () => {
    expect(
      mapReactorLike({
        type: "message.received",
        data: { message: { content: "hi" } },
      }),
    ).toEqual([{ type: "user", text: "hi" }])
  })

  test("mapReactorLike tool.done types", () => {
    const mapped = mapReactorLike({
      type: "tool.done",
      data: {
        result: {
          callId: "c1",
          name: "bash",
          content: "ok",
          isError: false,
        },
      },
    })
    expect(mapped.map((e) => e.type)).toEqual(["tool_result", "tool.boundary"])
  })

  test("unknown types map to empty", () => {
    expect(mapReactorLike({ type: "inference.usage", data: {} })).toEqual([])
  })
})

describe("attachSessionBridge", () => {
  test("fixture paints user / assistant / tool through shell", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        })
        const port = createRecordingPort()
        const bridge = attachSessionBridge(shell, port)
        try {
          bridge.play(FIXTURE_BUSY_SESSION)
          // Assistant rows are markdown; their blocks highlight asynchronously.
          await new Promise((resolve) => setTimeout(resolve, 250))
          await h.renderOnce()
          const frame = h.captureCharFrame()
          // Sticky follows the tail; early user line may scroll off.
          expect(shell.lineCount).toBeGreaterThanOrEqual(4)
          expect(frame).toContain("agent")
          expect(frame).toContain("bash")
          expect(frame).toContain("AGENTS.md")
          expect(frame).toContain("Done")
          expect(shell.session.run).toBe("idle")
        } finally {
          bridge.dispose()
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("Enter mid-run hits port.enqueue; badge tracks depth", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
          run: "busy",
        })
        const port = createRecordingPort()
        const bridge = attachSessionBridge(shell, port)
        try {
          shell.prompt.value = "queued please"
          shell.prompt.submit()
          await h.renderOnce()
          expect(port.calls.some((c) => c.op === "enqueue")).toBe(true)
          const enq = port.calls.find((c) => c.op === "enqueue")
          expect(enq).toEqual({
            op: "enqueue",
            text: "queued please",
            kind: "queue",
          })
          expect(badgeCount(shell.session)).toBe(1)
          expect(shell.pendingQueue).toBe(1)
          const frame = h.captureCharFrame()
          expect(frame).toMatch(/queue\s+1|pending\s+1|·\s*1/)
        } finally {
          bridge.dispose()
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("Alt+Enter mid-run hits port.enqueue steer", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
          run: "busy",
        })
        const port = createRecordingPort()
        const bridge = attachSessionBridge(shell, port)
        try {
          // Direct bridge path (Alt+Enter chord is terminal-dependent in mock).
          bridge.submit("steer now", "steer")
          await h.renderOnce()
          const enq = port.calls.find((c) => c.op === "enqueue")
          expect(enq).toEqual({
            op: "enqueue",
            text: "steer now",
            kind: "steer",
          })
          expect(badgeCount(shell.session)).toBe(1)
        } finally {
          bridge.dispose()
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("Ctrl+C hits port.interrupt and clears pending", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
          run: "busy",
        })
        const port = createRecordingPort()
        const bridge = attachSessionBridge(shell, port)
        try {
          bridge.submit("a", "queue")
          bridge.submit("b", "steer")
          expect(badgeCount(shell.session)).toBe(2)
          port.clear()
          h.pressKey("c", { ctrl: true })
          await h.renderOnce()
          expect(port.calls.some((c) => c.op === "interrupt")).toBe(true)
          expect(badgeCount(shell.session)).toBe(0)
          expect(shell.session.interruptFlash).toBe(true)
          expect(shell.session.run).toBe("idle")
        } finally {
          bridge.dispose()
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("queued item delivers at tool.boundary", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        })
        const port = createRecordingPort()
        const bridge = attachSessionBridge(shell, port)
        try {
          bridge.submit("follow up", "queue")
          expect(badgeCount(shell.session)).toBe(1)
          port.clear()
          bridge.handle({
            type: "tool.done",
            data: {
              result: {
                callId: "c9",
                name: "bash",
                content: "ok",
                isError: false,
              },
            },
          })
          expect(badgeCount(shell.session)).toBe(0)
          const deliver = port.calls.find((c) => c.op === "deliver")
          expect(deliver).toEqual({
            op: "deliver",
            item: expect.objectContaining({
              text: "follow up",
              kind: "queue",
            }),
          })
          await h.renderOnce()
          const frame = h.captureCharFrame()
          expect(frame).toContain("follow up")
        } finally {
          bridge.dispose()
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("idle submit hits sendImmediate", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        })
        const port = createRecordingPort()
        const bridge = attachSessionBridge(shell, port)
        try {
          bridge.submit("hello", "immediate")
          expect(port.calls[0]).toEqual({
            op: "sendImmediate",
            text: "hello",
          })
          expect(shell.session.run).toBe("busy")
        } finally {
          bridge.dispose()
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })
})
