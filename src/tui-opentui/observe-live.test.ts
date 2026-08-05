/**
 * Level 2c — live subagent observe: host-pushed rows + parent restore.
 */
import { describe, expect, test } from "bun:test"
import { focusOwner } from "./focus/index.js"
import { withTestRenderer } from "./harness.js"
import type { ObserveSession } from "./residuals.js"
import type { StreamRow } from "./stream.js"
import {
  appendObserveStreamRow,
  appendStreamRow,
  createAppShell,
  enterSubagentObserve,
  leaveSubagentObserve,
} from "./shell.js"

function liveChildSession(
  lines: readonly StreamRow[],
  opts?: { readonly agentId?: string; readonly description?: string },
): ObserveSession {
  return {
    sessionId: "live-child-1",
    agentId: opts?.agentId ?? "explore",
    description: opts?.description ?? "live map callers",
    lines,
  }
}

describe("live subagent observe", () => {
  test("enter accepts host live rows + agent label", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          run: "idle",
        })
        try {
          appendStreamRow(shell, { role: "user", text: "parent before" })

          const liveLines: StreamRow[] = [
            { role: "system", text: "— live child —" },
            { role: "assistant", text: "scanning repo…" },
            { role: "tool", text: "grep openListOverlay", meta: "tool" },
          ]
          enterSubagentObserve(
            shell,
            liveChildSession(liveLines, {
              agentId: "explore",
              description: "map callers",
            }),
          )

          expect(shell.observe?.sessionId).toBe("live-child-1")
          expect(shell.observe?.agentId).toBe("explore")
          expect(shell.observe?.description).toBe("map callers")
          expect(focusOwner(shell.focus)).toBe("observe")
          expect(shell.parentStreamLog).not.toBeNull()
          expect(
            shell.streamLog.some((r) => r.text === "scanning repo…"),
          ).toBe(true)
          expect(
            shell.streamLog.some((r) => r.text.includes("Viewing explore")),
          ).toBe(true)
          // Parent row is not visible while observing.
          expect(
            shell.streamLog.some((r) => r.text === "parent before"),
          ).toBe(false)
          expect(shell.layout.heights.agents).toBeGreaterThan(0)
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("host can append child stream events while observing", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          run: "idle",
        })
        try {
          enterSubagentObserve(
            shell,
            liveChildSession([{ role: "system", text: "seed" }]),
          )

          const ok = appendObserveStreamRow(shell, {
            role: "assistant",
            text: "live delta from host",
          })
          expect(ok).toBe(true)
          expect(
            shell.streamLog.some((r) => r.text === "live delta from host"),
          ).toBe(true)
          expect(
            shell.observe?.lines.some((r) => r.text === "live delta from host"),
          ).toBe(true)

          // Parent appends during observe stay on the snapshot, not the child view.
          appendStreamRow(shell, {
            role: "assistant",
            text: "parent mid-observe",
          })
          expect(
            shell.streamLog.some((r) => r.text === "parent mid-observe"),
          ).toBe(false)
          expect(
            shell.parentStreamLog?.some((r) => r.text === "parent mid-observe"),
          ).toBe(true)
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("leave restores parent transcript snapshot and focus lease", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          run: "idle",
        })
        try {
          appendStreamRow(shell, { role: "user", text: "parent user line" })
          appendStreamRow(shell, {
            role: "assistant",
            text: "parent assistant line",
          })
          const parentLen = shell.streamLog.length

          enterSubagentObserve(
            shell,
            liveChildSession([
              { role: "system", text: "child only" },
              { role: "assistant", text: "child work" },
            ]),
          )
          appendObserveStreamRow(shell, {
            role: "tool",
            text: "child tool hit",
            meta: "tool.done",
          })
          appendStreamRow(shell, {
            role: "system",
            text: "parent while away",
          })

          leaveSubagentObserve(shell)

          expect(shell.observe).toBeNull()
          expect(shell.parentStreamLog).toBeNull()
          expect(focusOwner(shell.focus)).not.toBe("observe")
          expect(shell.streamLog.length).toBeGreaterThanOrEqual(parentLen)
          expect(
            shell.streamLog.some((r) => r.text === "parent user line"),
          ).toBe(true)
          expect(
            shell.streamLog.some((r) => r.text === "parent while away"),
          ).toBe(true)
          expect(
            shell.streamLog.some((r) => r.text.includes("left observe")),
          ).toBe(true)
          // Child rows must not leak into the restored parent transcript.
          expect(
            shell.streamLog.some((r) => r.text === "child only"),
          ).toBe(false)
          expect(
            shell.streamLog.some((r) => r.text === "child tool hit"),
          ).toBe(false)
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("appendObserveStreamRow is no-op when not observing", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          run: "idle",
        })
        try {
          const before = shell.streamLog.length
          const ok = appendObserveStreamRow(shell, {
            role: "assistant",
            text: "should not land",
          })
          expect(ok).toBe(false)
          expect(shell.streamLog.length).toBe(before)
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("Esc key leaves observe and restores parent", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          run: "idle",
        })
        try {
          appendStreamRow(shell, { role: "user", text: "stay" })
          enterSubagentObserve(
            shell,
            liveChildSession([{ role: "system", text: "child" }]),
          )
          expect(shell.observe).not.toBeNull()

          // ESC needs disambiguation delay on the mock stdin path.
          h.pressKey("Escape")
          await new Promise((r) => setTimeout(r, 60))
          await h.renderOnce()

          expect(shell.observe).toBeNull()
          expect(shell.streamLog.some((r) => r.text === "stay")).toBe(true)
          expect(focusOwner(shell.focus)).not.toBe("observe")
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })
})
