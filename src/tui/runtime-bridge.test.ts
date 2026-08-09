import { describe, expect, spyOn, test } from "bun:test"
import {
  FIXTURE_BUSY_SESSION,
  attachSessionBridge,
  createRecordingPort,
  mapReactorLike,
  type TaskProgressSession,
} from "./runtime-bridge"
import { appendStreamRow, createAppShell, streamRowCount } from "./shell"
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
          // Plain Enter mid-run always steers now — "queue and wait quietly"
          // isn't a separate gesture from "queue to steer" anymore.
          expect(enq).toEqual({
            op: "enqueue",
            text: "queued please",
            kind: "steer",
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

  test("Alt+Enter mid-run hard-stops and reinjects, not a boundary wait", async () => {
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
          bridge.submit("stop now", "reinject")
          await h.renderOnce()
          // No enqueue at all — this never waits for a boundary. It
          // interrupts the live run, then sends straight through.
          expect(port.calls.some((c) => c.op === "enqueue")).toBe(false)
          expect(port.calls.map((c) => c.op)).toEqual(["interrupt", "sendImmediate"])
          const sent = port.calls.find((c) => c.op === "sendImmediate")
          expect(sent).toEqual({ op: "sendImmediate", text: "stop now" })
          expect(shell.session.run).toBe("busy")
          expect(badgeCount(shell.session)).toBe(0)
        } finally {
          bridge.dispose()
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("Ctrl+C hits port.interrupt and keeps pending for the next turn", async () => {
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
          expect(shell.session.interruptFlash).toBe(true)
          expect(shell.session.run).toBe("idle")
          // Handed over, not thrown away — and handed over here rather than
          // left waiting on an idle event the stop may never produce.
          expect(
            port.calls.flatMap((c) => (c.op === "deliver" ? [c.item.text] : [])),
          ).toEqual(["b", "a"])
          expect(badgeCount(shell.session)).toBe(0)
        } finally {
          bridge.dispose()
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("local classify keeps idle submits off the busy path", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        })
        const port = createRecordingPort({
          classifySubmit: (text) => (text.startsWith("/") ? "local" : "agent"),
        })
        const bridge = attachSessionBridge(shell, port)
        try {
          bridge.submit("/feedback quick test", "immediate")
          await h.renderOnce()
          expect(port.calls).toEqual([
            { op: "sendImmediate", text: "/feedback quick test" },
          ])
          expect(shell.session.run).toBe("idle")
          expect(badgeCount(shell.session)).toBe(0)
        } finally {
          bridge.dispose()
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("local classify mid-run does not enqueue or interrupt the agent turn", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        })
        const port = createRecordingPort({
          classifySubmit: (text) => (text.startsWith("/") ? "local" : "agent"),
        })
        const bridge = attachSessionBridge(shell, port)
        try {
          bridge.submit("/feedback note", "queue")
          await h.renderOnce()
          expect(port.calls).toEqual([
            { op: "sendImmediate", text: "/feedback note" },
          ])
          expect(port.calls.some((c) => c.op === "enqueue")).toBe(false)
          expect(shell.session.run).toBe("busy")
          expect(badgeCount(shell.session)).toBe(0)
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

  test("queued item delivers on a tool-less turn (inference.done, no tool calls)", async () => {
    // Regression for CL-5563: reactor.done only fires once, at agent
    // shutdown, never between turns — a plain-text reply with no tool calls
    // must still drain the queue, or a queued message sits forever.
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
          bridge.handle({ type: "inference.start" })
          bridge.handle({
            type: "inference.text.delta",
            data: { token: "hi" },
          })
          bridge.handle({ type: "inference.done" })
          expect(badgeCount(shell.session)).toBe(0)
          const deliver = port.calls.find((c) => c.op === "deliver")
          expect(deliver).toEqual({
            op: "deliver",
            item: expect.objectContaining({
              text: "follow up",
              kind: "queue",
            }),
          })
        } finally {
          bridge.dispose()
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("run and the phase ramp both return to idle after a tool-less inference.done, with no connector.reply", async () => {
    // Regression: a self-continuing workflow cycle
    // may never emit connector.reply, the only other event that clears
    // `run` and the turn's `isProcessing`. Without this, every future Enter
    // resolves to "queue" (busy is sticky) and, once the workflow stops
    // producing cycles, that queued message is never drained — CL-5563's
    // bug moved one layer over. The ramp indicator has the same failure
    // mode: it reads `isProcessing`, not `run`, so it can say "working"
    // forever even once dispatch itself is fixed.
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
          bridge.handle({ type: "inference.start" })
          bridge.handle({
            type: "inference.text.delta",
            data: { token: "hi" },
          })
          bridge.handle({ type: "inference.done" })
          expect(shell.session.run).toBe("idle")
          expect(shell.lockupPhase).toBeNull()

          port.clear()
          bridge.submit("are you still there", "queue")
          expect(port.calls).toEqual([
            { op: "sendImmediate", text: "are you still there" },
          ])
        } finally {
          bridge.dispose()
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("run returns to idle between two consecutive turns, not only at reactor shutdown", async () => {
    // CL-5570: `run` must flip back to idle at every turn boundary
    // (`inference.done`), so a second Enter after the first reply sends
    // immediately instead of routing through the queue. reactor.done is
    // shutdown, not a turn boundary, and never fires between turns.
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
          bridge.submit("first turn", "immediate")
          expect(shell.session.run).toBe("busy")
          bridge.handle({ type: "inference.start" })
          bridge.handle({
            type: "inference.text.delta",
            data: { token: "hi" },
          })
          bridge.handle({ type: "inference.done" })
          expect(shell.session.run).toBe("idle")

          bridge.submit("second turn", "immediate")
          expect(shell.session.run).toBe("busy")
          bridge.handle({ type: "inference.start" })
          bridge.handle({
            type: "inference.text.delta",
            data: { token: "hi again" },
          })
          bridge.handle({ type: "inference.done" })
          expect(shell.session.run).toBe("idle")
        } finally {
          bridge.dispose()
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("run stays busy after inference.done while a tool call is still outstanding", async () => {
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
          bridge.handle({ type: "inference.start" })
          bridge.handle({
            type: "inference.tool_call.start",
            data: { call: { id: "c1", name: "bash" } },
          })
          bridge.handle({ type: "inference.done" })
          expect(shell.session.run).toBe("busy")
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
  // Task dispatches no longer paint transcript rows (fleet board owns live
  // state — CL-5846). This pins that three parallel task calls leave the
  // stream clean of Task tool rows, while a non-panel tool still paints.
  test("three parallel task calls paint no transcript tool rows", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        })
        const bridge = attachSessionBridge(shell, createRecordingPort())
        try {
          const before = streamRowCount(shell)
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
          expect(toolRows.length).toBe(0)
          expect(streamRowCount(shell)).toBe(before)
        } finally {
          bridge.dispose()
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })
})

describe("syncAgentProgress", () => {
  function taskSession(over: Partial<TaskProgressSession>): TaskProgressSession {
    return {
      id: "task-1",
      status: "running",
      currentToolName: "grep",
      currentToolPreview: null,
      currentToolStartedAt: null,
      startedAt: 0,
      lastActivityAt: 0,
      ...over,
    }
  }

  test("task dispatches paint no transcript rows for progress to rewrite (fleet board owns live state)", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        })
        for (let i = 0; i < 40; i++) {
          appendStreamRow(shell, { role: "assistant", text: `filler ${i}` })
        }
        let nowMs = 0
        const bridge = attachSessionBridge(shell, createRecordingPort(), {
          now: () => nowMs,
        })
        try {
          const before = streamRowCount(shell)
          bridge.handle({
            type: "inference.tool_call.end",
            data: {
              name: "task",
              callId: "task-1",
              arguments: { description: "Review permission gate" },
            },
          })
          await h.renderOnce()
          expect(streamRowCount(shell)).toBe(before)

          nowMs = 42_000
          bridge.syncAgentProgress([taskSession({ lastActivityAt: nowMs })])
          // No transcript Task row exists; progress is a no-op for stream log.
          expect(streamRowCount(shell)).toBe(before)
        } finally {
          bridge.dispose()
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("a finished task result is dropped with the call (no unpaired terminal Task row)", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        })
        const bridge = attachSessionBridge(shell, createRecordingPort())
        try {
          const before = streamRowCount(shell)
          bridge.handle({
            type: "inference.tool_call.end",
            data: {
              name: "task",
              callId: "task-1",
              arguments: { description: "Review mouse/paste" },
            },
          })
          bridge.handle({
            type: "tool.done",
            data: { result: { callId: "task-1", name: "task", content: "done", isError: false } },
          })
          expect(streamRowCount(shell)).toBe(before)
          bridge.syncAgentProgress([taskSession({ status: "done" })])
          expect(streamRowCount(shell)).toBe(before)
        } finally {
          bridge.dispose()
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })
})

describe("task checklist calls stay out of the transcript", () => {
  test("a manage_tasks call and its result paint no rows", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        })
        const bridge = attachSessionBridge(shell, createRecordingPort())
        try {
          appendStreamRow(shell, { role: "assistant", text: "planning the sweep" })
          const before = streamRowCount(shell)

          bridge.handle({
            type: "inference.tool_call.end",
            data: {
              name: "manage_tasks",
              callId: "mt-1",
              arguments: { action: "create", tasks: [{ title: "audit", status: "todo" }] },
            },
          })
          bridge.handle({
            type: "tool.done",
            data: {
              result: { callId: "mt-1", name: "manage_tasks", content: "ok", isError: false },
            },
          })

          // The list lives in the task panel; scrollback must not carry a
          // second copy of it.
          expect(streamRowCount(shell)).toBe(before)
        } finally {
          bridge.dispose()
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("a task dispatch call and its result paint no rows (fleet board owns live state)", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        })
        const bridge = attachSessionBridge(shell, createRecordingPort())
        try {
          appendStreamRow(shell, { role: "assistant", text: "spinning workers" })
          const before = streamRowCount(shell)

          bridge.handle({
            type: "inference.tool_call.end",
            data: {
              name: "task",
              callId: "task-1",
              arguments: {
                description: "explore auth",
                prompt: "map auth callers",
                intent: "explore",
              },
            },
          })
          bridge.handle({
            type: "tool.done",
            data: {
              result: {
                callId: "task-1",
                name: "task",
                content: "Summary: auth is in src/auth",
                isError: false,
              },
            },
          })

          // Live Task rows restate what the fleet board already shows.
          expect(streamRowCount(shell)).toBe(before)
        } finally {
          bridge.dispose()
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("an errored manage_tasks result is dropped rather than left unpaired", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        })
        const bridge = attachSessionBridge(shell, createRecordingPort())
        try {
          const before = streamRowCount(shell)
          bridge.handle({
            type: "inference.tool_call.end",
            data: { name: "manage_tasks", callId: "mt-2", arguments: { action: "update" } },
          })
          bridge.handle({
            type: "tool.done",
            data: {
              result: { callId: "mt-2", name: "manage_tasks", content: "boom", isError: true },
            },
          })
          expect(streamRowCount(shell)).toBe(before)
        } finally {
          bridge.dispose()
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("other tools still paint normally", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        })
        const bridge = attachSessionBridge(shell, createRecordingPort())
        try {
          const before = streamRowCount(shell)
          bridge.handle({
            type: "inference.tool_call.end",
            data: { name: "grep", callId: "g-1", arguments: { pattern: "zones" } },
          })
          expect(streamRowCount(shell)).toBeGreaterThan(before)
        } finally {
          bridge.dispose()
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })
})
