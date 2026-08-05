/**
 * Wave 6: command palette, long-log windowing, chrome zones, keyboard copy.
 */
import { describe, expect, test } from "bun:test"
import { IDLE_TRANSCRIPT_FLOOR } from "./geometry/index"
import { focusOwner, scrollLease } from "./focus/index"
import { withTestRenderer } from "./harness"
import {
  LONG_LOG_COLLAPSE_THRESHOLD,
  LONG_LOG_WINDOW,
  mustWindow,
} from "./long-log"
import { openPermissionsOverlay } from "./overlays"
import {
  acceptOverlaySelection,
  appendStreamRow,
  closeInsetOverlay,
  copyActiveMessage,
  createAppShell,
  moveOverlaySelection,
  openPalette,
  setChromeZones,
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
  test("multi-thousand append stays interactive (windowed paint)", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        })
        try {
          const n = LONG_LOG_COLLAPSE_THRESHOLD + 50
          expect(mustWindow(n)).toBe(true)

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
          // Paint tree is windowed, not full history.
          const painted = shell.transcript.getChildren().length
          // collapse marker + window rows
          expect(painted).toBeLessThanOrEqual(LONG_LOG_WINDOW + 2)
          expect(painted).toBeGreaterThan(0)
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
  test("copyActiveMessage writes last non-system row", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        })
        try {
          const clip = createRecordingClipboard()
          // AppShell.clipboard is mutable for tests; cast via unknown.
          ;(shell as unknown as { clipboard: typeof clip }).clipboard = clip

          appendStreamRow(shell, { role: "user", text: "copy me please" })
          appendStreamRow(shell, {
            role: "system",
            text: "noise",
            meta: "sys",
          })

          const ok = copyActiveMessage(shell)
          expect(ok).toBe(true)
          expect(clip.writes.length).toBe(1)
          expect(clip.writes[0]).toBe("copy me please")
          expect(
            shell.streamLog.some(
              (r) => r.role === "system" && r.text.startsWith("copied message"),
            ),
          ).toBe(true)
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("copy with empty log reports nothing", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        })
        try {
          const ok = copyActiveMessage(shell)
          expect(ok).toBe(false)
          expect(
            shell.streamLog.some((r) => r.text.includes("nothing to copy")),
          ).toBe(true)
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })
})
