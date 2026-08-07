/**
 * Wave 6: command palette, long-log windowing, chrome zones, keyboard copy.
 */
import { describe, expect, test } from "bun:test"
import { IDLE_TRANSCRIPT_FLOOR } from "./geometry/index"
import { focusOwner, scrollLease } from "./focus/index"
import { withTestRenderer } from "./harness"
import { MAX_RETAINED_STREAM_ROWS } from "./long-log"
import { openPermissionsOverlay } from "./overlays"
import {
  acceptOverlaySelection,
  appendStreamRow,
  closeInsetOverlay,
  confirmCopySelection,
  createAppShell,
  enterCopyMode,
  enterSubagentObserve,
  moveOverlaySelection,
  openInsetOverlay,
  openPalette,
  replaceStreamRowAt,
  setChromeZones,
  streamRowAt,
  streamRowCount,
} from "./shell"
import { createRecordingClipboard } from "./copy-path"

describe("Wave 6: command palette", () => {
  test("open → navigate → Esc restores prompt", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        })
        try {
          expect(focusOwner(shell.focus)).toBe("prompt")
          openPalette(shell)
          expect(shell.overlayKind).toBe("palette")
          expect(shell.overlayList).not.toBeNull()
          expect(shell.paletteCommands.length).toBeGreaterThan(0)
          expect(focusOwner(shell.focus)).toBe("palette")
          expect(scrollLease(shell.focus)).toBe("palette")
          expect(shell.layout.overlayMode).toBe("inset")
          expect(shell.overlayHost.visible).toBe(true)

          await h.renderOnce()
          const frame = h.captureCharFrame()
          expect(frame).toMatch(/palette/i)
          // List labels live in overlayItems (frame may clip first row under tight height).
          expect(shell.overlayItems[0]).toBe("Open permissions")
          expect(shell.overlayItems.some((l) => l.includes("permissions"))).toBe(
            true,
          )

          moveOverlaySelection(shell, 1)
          expect(shell.overlayList!.activeIndex).toBe(1)

          closeInsetOverlay(shell)
          expect(shell.overlayList).toBeNull()
          expect(shell.overlayKind).toBeNull()
          expect(focusOwner(shell.focus)).toBe("prompt")
          expect(shell.layout.overlayMode).toBe("closed")
          expect(shell.layout.transcriptHeight).toBeGreaterThanOrEqual(
            IDLE_TRANSCRIPT_FLOOR,
          )
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("accept action (help) opens help overlay", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        })
        try {
          openPalette(shell)
          const helpIdx = shell.paletteCommands.findIndex((c) => c.id === "help")
          expect(helpIdx).toBeGreaterThanOrEqual(0)
          for (let i = 0; i < helpIdx; i++) moveOverlaySelection(shell, 1)
          expect(shell.paletteCommands[shell.overlayList!.activeIndex]!.id).toBe(
            "help",
          )

          acceptOverlaySelection(shell)
          // Help is a residual list surface — palette closes, help opens.
          expect(shell.overlayKind).toBe("help")
          expect(shell.overlayList).not.toBeNull()
          expect(focusOwner(shell.focus)).toBe("overlay")
          closeInsetOverlay(shell)
          expect(shell.overlayList).toBeNull()
          expect(focusOwner(shell.focus)).toBe("prompt")
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("palette stacks over permissions; Esc restores permissions then prompt", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        })
        try {
          openPermissionsOverlay(shell, {
            items: ["Allow once", "Deny", "Always allow"],
          })
          expect(shell.overlayKind).toBe("permissions")
          expect(focusOwner(shell.focus)).toBe("overlay")

          openPalette(shell)
          expect(shell.overlayKind).toBe("palette")
          expect(focusOwner(shell.focus)).toBe("palette")

          closeInsetOverlay(shell)
          expect(shell.overlayKind).toBe("permissions")
          expect(focusOwner(shell.focus)).toBe("overlay")
          expect(shell.overlayItems[0]).toBe("Allow once")

          closeInsetOverlay(shell)
          expect(shell.overlayList).toBeNull()
          expect(focusOwner(shell.focus)).toBe("prompt")
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })
})

describe("Wave 6: long-log windowing", () => {
  test("multi-thousand append stays interactive (full-retained-log paint)", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        })
        try {
          // Below MAX_RETAINED_STREAM_ROWS: no eviction, so painted == n + 1 below holds.
          const n = MAX_RETAINED_STREAM_ROWS - 50

          const t0 = performance.now()
          for (let i = 0; i < n; i++) {
            const role =
              i % 3 === 0 ? "user" : i % 3 === 1 ? "assistant" : "tool"
            if (role === "tool") {
              appendStreamRow(shell, {
                role: "tool",
                text: `row-${i}`,
                meta: "bash",
              })
            } else {
              appendStreamRow(shell, {
                role,
                text: `row-${i}`,
              })
            }
          }
          const elapsed = performance.now() - t0

          expect(shell.streamLog.length).toBe(n)
          expect(shell.lineCount).toBe(n)
          // Paint tree tracks the full retained log 1:1 (CL-5553) — capped at
          // MAX_RETAINED_STREAM_ROWS by CL-5551, not a smaller paint window,
          // so every retained row stays reachable by scrolling.
          const painted = shell.transcript.getChildren().length
          expect(painted).toBeLessThanOrEqual(MAX_RETAINED_STREAM_ROWS + 1)
          expect(painted).toBe(n + 1) // +1: bottom-anchor spacer
          // Smoke: no multi-second peg on append storm
          expect(elapsed).toBeLessThan(5_000)

          await h.renderOnce()
          const frame = h.captureCharFrame()
          // Tail still visible
          expect(frame).toContain(`row-${n - 1}`)
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test(
    "a long, tool-heavy session retains a bounded tail, not the whole history",
    async () => {
      await withTestRenderer(
        async (h) => {
          const shell = createAppShell(h.renderer, {
            terminal: { columns: 80, rows: 24 },
            wireKeys: false,
          })
          try {
            const n = MAX_RETAINED_STREAM_ROWS + 200
            for (let i = 0; i < n; i++) {
              appendStreamRow(shell, { role: "tool", text: `row-${i}`, meta: "bash" })
            }

            // Retention caps the backing array itself, not just the paint window.
            expect(shell.streamLog.length).toBe(MAX_RETAINED_STREAM_ROWS)
            // But the append count the bridge relies on for bookkeeping stays
            // absolute — it must never appear to shrink just because rows were
            // evicted underneath it.
            expect(streamRowCount(shell)).toBe(n)
            // The oldest surviving row is the one at the eviction boundary.
            expect(shell.streamLog[0]).toMatchObject({
              text: `row-${n - MAX_RETAINED_STREAM_ROWS}`,
            })
            // Evicted rows read back as gone, not as some other row's data.
            expect(streamRowAt(shell, 0)).toBeUndefined()
            expect(streamRowAt(shell, n - 1)).toMatchObject({ text: `row-${n - 1}` })
          } finally {
            shell.dispose()
          }
        },
        { width: 80, height: 24 },
      )
    },
    20_000,
  )

  test(
    "replaceStreamRowAt keeps targeting the right row across an eviction (absolute index survives the trim)",
    async () => {
      await withTestRenderer(
        async (h) => {
          const shell = createAppShell(h.renderer, {
            terminal: { columns: 80, rows: 24 },
            wireKeys: false,
          })
          try {
            appendStreamRow(shell, { role: "tool", text: "pinned call", meta: "bash" })
            const pinnedIndex = streamRowCount(shell) - 1

            // Push the pinned row well past the retention cap.
            for (let i = 0; i < MAX_RETAINED_STREAM_ROWS + 100; i++) {
              appendStreamRow(shell, { role: "tool", text: `filler-${i}`, meta: "bash" })
            }
            // The pinned row itself was evicted; a rewrite must be a safe no-op,
            // not a write to whatever row now occupies that array slot.
            const survivorAtSameSlot = streamRowAt(shell, pinnedIndex)
            expect(survivorAtSameSlot).toBeUndefined()

            const recentIndex = streamRowCount(shell) - 1
            const before = streamRowAt(shell, recentIndex)
            replaceStreamRowAt(shell, recentIndex, { role: "tool", text: "edited", meta: "bash" })
            expect(streamRowAt(shell, recentIndex)).toMatchObject({ text: "edited" })
            expect(before).not.toMatchObject({ text: "edited" })
          } finally {
            shell.dispose()
          }
        },
        { width: 80, height: 24 },
      )
    },
    20_000,
  )
})

describe("Wave 6: chrome zones", () => {
  test("goal / task / agents measured via geometry (not guessed)", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        })
        try {
          expect(shell.layout.heights.goal).toBe(0)
          expect(shell.layout.heights.task).toBe(0)
          expect(shell.layout.heights.agents).toBe(0)
          expect(shell.goalBox.visible).toBe(false)

          setChromeZones(shell, {
            goal: "goal: Wave 6",
            task: "task: chrome zones",
            agents: "agents: 0",
          })

          expect(shell.layout.heights.goal).toBe(1)
          expect(shell.layout.heights.task).toBe(1)
          expect(shell.layout.heights.agents).toBe(1)
          expect(shell.goalBox.visible).toBe(true)
          expect(shell.taskBox.visible).toBe(true)
          expect(shell.agentsBox.visible).toBe(true)
          // Transcript still holds constitution floor when possible
          expect(shell.layout.transcriptHeight).toBeGreaterThanOrEqual(1)

          await h.renderOnce()
          const frame = h.captureCharFrame()
          expect(frame).toContain("goal: Wave 6")
          expect(frame).toContain("task: chrome zones")
          expect(frame).toContain("agents: 0")

          setChromeZones(shell, { goal: null, task: null, agents: null })
          expect(shell.layout.heights.goal).toBe(0)
          expect(shell.goalBox.visible).toBe(false)
          expect(shell.layout.transcriptHeight).toBeGreaterThanOrEqual(
            IDLE_TRANSCRIPT_FLOOR,
          )
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })
})

describe("Wave 6: keyboard copy path", () => {
  test("enterCopyMode freezes targets and defaults to last", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        })
        try {
          appendStreamRow(shell, { role: "user", text: "first row" })
          appendStreamRow(shell, { role: "assistant", text: "second row" })
          appendStreamRow(shell, {
            role: "system",
            text: "noise",
            meta: "sys",
          })
          const n = shell.streamLog.length

          const ok = enterCopyMode(shell)
          expect(ok).toBe(true)
          expect(shell.overlayKind).toBe("copy")
          expect(shell.copyTargets?.length).toBe(2)
          expect(shell.overlayList?.activeIndex).toBe(1)
          expect(shell.streamLog.length).toBe(n)

          // Live stream change must not alter frozen targets.
          appendStreamRow(shell, { role: "user", text: "after open" })
          expect(shell.copyTargets?.map((t) => t.text)).toEqual([
            "first row",
            "second row",
          ])
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("confirm last target without navigation", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        })
        try {
          const clip = createRecordingClipboard()
          ;(shell as unknown as { clipboard: typeof clip }).clipboard = clip

          appendStreamRow(shell, { role: "user", text: "copy me please" })
          appendStreamRow(shell, {
            role: "system",
            text: "noise",
            meta: "sys",
          })
          const n = shell.streamLog.length

          expect(enterCopyMode(shell)).toBe(true)
          expect(confirmCopySelection(shell)).toBe(true)
          expect(clip.writes).toEqual(["copy me please"])
          expect(shell.streamLog.length).toBe(n)
          expect(shell.streamLog.every((r) => r.meta !== "copy")).toBe(true)
          expect(shell.overlayList).toBeNull()
          expect(shell.statusFlash).toContain("Copied")
          await h.renderOnce()
          expect(h.captureCharFrame()).toContain("Copied")
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("navigate up then confirm copies earlier target", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        })
        try {
          const clip = createRecordingClipboard()
          ;(shell as unknown as { clipboard: typeof clip }).clipboard = clip

          appendStreamRow(shell, { role: "user", text: "alpha" })
          appendStreamRow(shell, { role: "assistant", text: "beta" })
          appendStreamRow(shell, { role: "tool", text: "gamma", meta: "bash" })
          const n = shell.streamLog.length

          expect(enterCopyMode(shell)).toBe(true)
          // Default last (gamma); up → beta; up → alpha
          moveOverlaySelection(shell, -1)
          moveOverlaySelection(shell, -1)
          expect(confirmCopySelection(shell)).toBe(true)
          expect(clip.writes).toEqual(["alpha"])
          expect(shell.streamLog.length).toBe(n)
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("empty log flashes without stream mutation", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        })
        try {
          const ok = enterCopyMode(shell)
          expect(ok).toBe(false)
          expect(shell.streamLog.length).toBe(0)
          expect(shell.overlayList).toBeNull()
          expect(shell.statusFlash).toBe("nothing to copy")
          await h.renderOnce()
          expect(h.captureCharFrame()).toContain("nothing to copy")
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("Esc cancels without clipboard write", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        })
        try {
          const clip = createRecordingClipboard()
          ;(shell as unknown as { clipboard: typeof clip }).clipboard = clip

          appendStreamRow(shell, { role: "user", text: "leave me" })
          const n = shell.streamLog.length
          expect(enterCopyMode(shell)).toBe(true)
          closeInsetOverlay(shell)
          expect(clip.writes).toEqual([])
          expect(shell.streamLog.length).toBe(n)
          expect(shell.overlayList).toBeNull()
          expect(shell.copyTargets).toBeNull()
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("does not open copy while another overlay is open", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        })
        try {
          appendStreamRow(shell, { role: "user", text: "x" })
          openInsetOverlay(shell, ["Allow", "Deny"])
          expect(shell.overlayKind).toBe("demo")
          expect(enterCopyMode(shell)).toBe(false)
          expect(shell.overlayKind).toBe("demo")
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("observe copy does not mutate parent snapshot", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        })
        try {
          const clip = createRecordingClipboard()
          ;(shell as unknown as { clipboard: typeof clip }).clipboard = clip

          appendStreamRow(shell, { role: "user", text: "parent only" })
          enterSubagentObserve(shell, {
            sessionId: "s1",
            agentId: "explore",
            description: "scan",
            lines: [{ role: "assistant", text: "child line" }],
          })
          const parentSnap = shell.parentStreamLog?.slice() ?? []
          const childLen = shell.streamLog.length

          expect(enterCopyMode(shell)).toBe(true)
          expect(confirmCopySelection(shell)).toBe(true)
          expect(clip.writes).toEqual(["child line"])
          expect(shell.streamLog.length).toBe(childLen)
          expect(shell.parentStreamLog).toEqual(parentSnap)
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })
})
