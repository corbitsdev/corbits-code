/**
 * CL-6291: soft steer / follow-up must keep workers alive; only hard stop
 * (Ctrl+C → doInterrupt → port.interrupt) tears the fleet down via agent close.
 *
 * Owned separately from runtime-bridge.test.ts so gesture remaps (sibling)
 * do not collide with these invariants.
 */
import { describe, expect, test } from "bun:test"
import {
  attachSessionBridge,
  createRecordingPort,
} from "./runtime-bridge"
import { createAppShell } from "./shell"
import { withTestRenderer } from "./harness"
import { badgeCount } from "./session-queue"

describe("CL-6291 worker-alive invariants", () => {
  test("busy Enter soft-steers: enqueue steer, never port.interrupt", async () => {
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
          shell.prompt.value = "steer please"
          shell.prompt.submit()
          await h.renderOnce()
          expect(port.calls.some((c) => c.op === "interrupt")).toBe(false)
          expect(port.calls.some((c) => c.op === "enqueue")).toBe(true)
          const enq = port.calls.find((c) => c.op === "enqueue")
          expect(enq).toEqual({
            op: "enqueue",
            text: "steer please",
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

  test("bridge submit steer / queue (follow-up) never calls interrupt", async () => {
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
          bridge.submit("redirect soft", "steer")
          bridge.submit("follow up later", "queue")
          await h.renderOnce()
          expect(port.calls.some((c) => c.op === "interrupt")).toBe(false)
          expect(
            port.calls.filter((c) => c.op === "enqueue").map((c) =>
              c.op === "enqueue" ? { text: c.text, kind: c.kind } : null,
            ),
          ).toEqual([
            { text: "redirect soft", kind: "steer" },
            { text: "follow up later", kind: "queue" },
          ])
          expect(badgeCount(shell.session)).toBe(2)
        } finally {
          bridge.dispose()
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("tool.boundary deliver does not interrupt", async () => {
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
          bridge.submit("at next boundary", "steer")
          expect(badgeCount(shell.session)).toBe(1)
          port.clear()
          bridge.handle({ type: "tool.boundary" })
          await h.renderOnce()
          expect(port.calls.some((c) => c.op === "interrupt")).toBe(false)
          expect(port.calls.some((c) => c.op === "deliver")).toBe(true)
          const delivered = port.calls.find((c) => c.op === "deliver")
          expect(delivered?.op === "deliver" ? delivered.item.text : null).toBe(
            "at next boundary",
          )
          expect(badgeCount(shell.session)).toBe(0)
        } finally {
          bridge.dispose()
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("Ctrl+C / doInterrupt still calls port.interrupt", async () => {
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
          bridge.submit("kept", "steer")
          expect(badgeCount(shell.session)).toBe(1)
          port.clear()
          h.pressKey("c", { ctrl: true })
          await h.renderOnce()
          expect(port.calls.some((c) => c.op === "interrupt")).toBe(true)
          // Hard stop still hands pending over rather than discarding them.
          expect(
            port.calls.flatMap((c) => (c.op === "deliver" ? [c.item.text] : [])),
          ).toEqual(["kept"])
        } finally {
          bridge.dispose()
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("bridge.interrupt() hits port.interrupt (hard-stop API)", async () => {
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
          bridge.interrupt()
          await h.renderOnce()
          expect(port.calls.map((c) => c.op)).toContain("interrupt")
        } finally {
          bridge.dispose()
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })
})
