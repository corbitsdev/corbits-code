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
          expect(shell.lineCount).toBeGreaterThanOrEqual(3)
          expect(frame).toContain("I'll list the directory.")
          // The call and its output are one row: the command stays the subject
          // and the listing sits behind the expand arrow.
          expect(frame).toContain("Bash ls -la")
          expect(frame).not.toContain("AGENTS.md")
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

  test("token-by-token deltas grow one assistant row", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        })
        const bridge = attachSessionBridge(shell, createRecordingPort())
        try {
          const tokens = "Hello there, this is one streamed reply.".split(" ")
          bridge.handle({ type: "inference.start", data: {} })
          for (const token of tokens) {
            bridge.handle({
              type: "inference.text.delta",
              data: { token: `${token} ` },
            })
          }
          bridge.handle({ type: "inference.done", data: {} })
          bridge.handle({ type: "reactor.done", data: {} })

          const assistant = shell.streamLog.filter((r) => r.role === "assistant")
          expect(assistant).toHaveLength(1)
          expect(assistant[0]?.text.trim()).toBe(
            "Hello there, this is one streamed reply.",
          )
          expect(assistant[0]?.streaming).toBe(false)
        } finally {
          bridge.dispose()
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("thinking deltas coalesce and never become plain system rows", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        })
        const bridge = attachSessionBridge(shell, createRecordingPort())
        try {
          bridge.handle({ type: "inference.start", data: {} })
          for (const token of ["The ", "user ", "said ", "hi."]) {
            bridge.handle({
              type: "inference.thinking.delta",
              data: { token },
            })
          }
          bridge.handle({ type: "inference.text.delta", data: { token: "Hi!" } })
          bridge.handle({ type: "reactor.done", data: {} })

          const system = shell.streamLog.filter((r) => r.role === "system")
          expect(system.every((r) => r.meta === "thinking")).toBe(true)
          const thinking = system.filter((r) => r.meta === "thinking")
          expect(thinking).toHaveLength(1)
          expect(thinking[0]?.text).toBe("The user said hi.")
          expect(
            shell.streamLog.filter((r) => r.role === "assistant"),
          ).toHaveLength(1)
        } finally {
          bridge.dispose()
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("a submitted prompt echoes exactly once", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        })
        const bridge = attachSessionBridge(shell, createRecordingPort())
        try {
          bridge.submit("hi", "immediate")
          // The runtime replays the accepted prompt back onto the event stream.
          bridge.handle({
            type: "message.received",
            data: { message: { content: "hi" } },
          })
          expect(
            shell.streamLog.filter((r) => r.role === "user" && r.text === "hi"),
          ).toHaveLength(1)
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

describe("failed sends", () => {
  const errorRows = (shell: { streamLog: readonly { role: string; meta?: string; text: string }[] }) =>
    shell.streamLog.filter((r) => r.meta === "error").map((r) => r.text)

  test("a recognised auth expiry says what to press; anything else keeps its message", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        })
        const bridge = attachSessionBridge(shell, createRecordingPort())
        try {
          bridge.handle({
            type: "inference.error",
            data: {
              error: {
                message: 'Codex profile "default" is not authorized. Log in again.',
              },
            },
          })
          bridge.handle({
            type: "inference.error",
            data: { error: { message: "socket hang up" } },
          })

          const rows = errorRows(shell)
          expect(rows[0]).toContain("sign-in expired")
          expect(rows[0]).toContain("/model")
          expect(rows[1]).toBe("socket hang up")
        } finally {
          bridge.dispose()
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })
})

describe("committed inference retry", () => {
  /**
   * The reactor re-streams a committed attempt from a fresh inference.start
   * after a same-source quota retry, so the transcript must retract the failed
   * attempt rather than append the replay underneath it.
   */
  const COMMITTED_RETRY_EVENTS = [
    { type: "inference.start", data: {} },
    { type: "inference.text.delta", data: { token: "partial answer" } },
    {
      type: "inference.tool_call.end",
      data: { name: "bash", callId: "c1", arguments: { command: "ls" } },
    },
    {
      type: "inference.error",
      data: { error: { category: "quota_exhausted", message: "rate limited" } },
    },
    { type: "inference.retry", data: { attempt: 1, delayMs: 0 } },
    { type: "inference.start", data: {} },
    { type: "inference.text.delta", data: { token: "final answer" } },
    { type: "inference.done", data: {} },
    { type: "reactor.done", data: {} },
  ] as const

  test("does not duplicate the failed attempt's text or strand its tool row", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        })
        const bridge = attachSessionBridge(shell, createRecordingPort())
        try {
          for (const event of COMMITTED_RETRY_EVENTS) bridge.handle(event)

          const text = shell.streamLog.map((r) => r.text).join("\n")
          expect(text).toContain("final answer")
          expect(text).not.toContain("partial answer")
          expect(shell.streamLog.filter((r) => r.pending)).toEqual([])
        } finally {
          bridge.dispose()
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })
})

describe("parallel sub-agent dispatch on the live session bridge", () => {
  // The live main-session path tracks a call's row by callId in its own map
  // (applyToolCall/applyToolResult), independent of tool-rows.ts's name-based
  // pendingCallIndex — this pins that down so a future change to either path
  // cannot silently reintroduce CL-5562's misattribution on the parent
  // transcript specifically (the observe overlay and resumed history are
  // covered separately in tool-rows.test.ts / history-hydrate.test.ts).
  test("three parallel task calls resolve to three rows, each with its own result", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        })
        const bridge = attachSessionBridge(shell, createRecordingPort())
        try {
          const events = [
            { type: "inference.start", data: {} },
            {
              type: "inference.tool_call.end",
              data: { name: "task", callId: "c1", arguments: { description: "Fix CL-5559" } },
            },
            {
              type: "inference.tool_call.end",
              data: { name: "task", callId: "c2", arguments: { description: "Fix CL-5560" } },
            },
            {
              type: "inference.tool_call.end",
              data: { name: "task", callId: "c3", arguments: { description: "Fix CL-5561" } },
            },
            { type: "inference.done", data: {} },
            { type: "tool.start", data: { call: { id: "c1", name: "task" } } },
            { type: "tool.start", data: { call: { id: "c2", name: "task" } } },
            { type: "tool.start", data: { call: { id: "c3", name: "task" } } },
            // Completion order does not follow dispatch order.
            { type: "tool.done", data: { result: { callId: "c2", name: "task", content: "done c2" } } },
            { type: "tool.done", data: { result: { callId: "c1", name: "task", content: "done c1" } } },
            { type: "tool.done", data: { result: { callId: "c3", name: "task", content: "done c3" } } },
            { type: "reactor.done", data: {} },
          ] as const
          for (const event of events) bridge.handle(event)

          const toolRows = shell.streamLog.filter((r) => r.role === "tool")
          expect(toolRows.length).toBe(3)
          expect(toolRows.every((r) => r.pending !== true)).toBe(true)
          expect(toolRows.every((r) => r.failed !== true)).toBe(true)
          expect(toolRows.map((r) => r.text)).toEqual(["done c1", "done c2", "done c3"])
        } finally {
          bridge.dispose()
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })
})
