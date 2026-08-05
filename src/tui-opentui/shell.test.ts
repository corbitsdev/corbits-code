/**
 * Integration: app shell + harness — sticky transcript, focus, key chords.
 */
import { describe, expect, test } from "bun:test"
import type { KeyEvent } from "@opentui/core"
import { IDLE_TRANSCRIPT_FLOOR } from "./geometry/index"
import { focusOwner, scrollLease } from "./focus/index"
import {
  createListViewport,
  moveActive,
  visibleSlice,
} from "./list-viewport"
import { withTestRenderer } from "./harness"
import {
  appendTranscript,
  createAppShell,
  isTranscriptFollowing,
  setPendingQueue,
  shellFocusPrompt,
  shellFocusTranscript,
  stickyMode,
  toggleShellFocus,
} from "./shell"

describe("createAppShell", () => {
  test("builds header / transcript / prompt / status with floor geometry", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          title: "test",
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        })
        try {
          expect(shell.header).toBeDefined()
          expect(shell.transcript).toBeDefined()
          expect(shell.prompt).toBeDefined()
          expect(shell.status).toBeDefined()
          expect(shell.transcript.stickyScroll).toBe(true)
          expect(shell.layout.transcriptHeight).toBeGreaterThanOrEqual(
            IDLE_TRANSCRIPT_FLOOR,
          )
          expect(focusOwner(shell.focus)).toBe("prompt")
          expect(scrollLease(shell.focus)).toBe("transcript")
          await h.renderOnce()
          const frame = h.captureCharFrame()
          expect(frame).toContain("test")
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("append follows tail while sticky at bottom", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        })
        try {
          for (let i = 0; i < 40; i++) {
            appendTranscript(shell, `line-${i}`)
          }
          await h.renderOnce()
          await h.renderOnce()
          expect(shell.lineCount).toBe(40)
          expect(isTranscriptFollowing(shell)).toBe(true)
          expect(stickyMode(shell)).toBe("FOLLOW")
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("scroll up pins; append does not yank viewport", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        })
        try {
          for (let i = 0; i < 50; i++) {
            appendTranscript(shell, `seed-${i}`)
          }
          await h.renderOnce()
          expect(isTranscriptFollowing(shell)).toBe(true)

          shell.transcript.scrollTop = 0
          await h.renderOnce()
          expect(isTranscriptFollowing(shell)).toBe(false)
          expect(stickyMode(shell)).toBe("PINNED")
          const pinnedTop = shell.transcript.scrollTop

          appendTranscript(shell, "after-pin")
          await h.renderOnce()
          expect(isTranscriptFollowing(shell)).toBe(false)
          expect(Math.abs(shell.transcript.scrollTop - pinnedTop)).toBeLessThan(
            2,
          )
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("focus lease: prompt vs transcript", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        })
        try {
          expect(focusOwner(shell.focus)).toBe("prompt")
          shellFocusTranscript(shell)
          expect(focusOwner(shell.focus)).toBe("transcript")
          shellFocusPrompt(shell)
          expect(focusOwner(shell.focus)).toBe("prompt")
          toggleShellFocus(shell)
          expect(focusOwner(shell.focus)).toBe("transcript")
          await h.renderOnce()
          // Status is StyledText — assert via painted frame, not .content type
          expect(h.captureCharFrame()).toContain("focus transcript")
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("Tab key toggles shell focus when wireKeys enabled", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
        })
        try {
          expect(focusOwner(shell.focus)).toBe("prompt")
          h.pressKey("Tab")
          await h.renderOnce()
          expect(focusOwner(shell.focus)).toBe("transcript")
          h.pressKey("Tab")
          await h.renderOnce()
          expect(focusOwner(shell.focus)).toBe("prompt")
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("Enter / Alt+Enter / Ctrl+C key shapes on shell renderer", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 60, rows: 20 },
        wireKeys: false,
      })
      try {
        const captured: KeyEvent[] = []
        h.renderer.keyInput.on("keypress", (key: KeyEvent) => {
          captured.push(key)
        })

        h.pressKey("Enter")
        await h.renderOnce()
        const enter = captured.at(-1)!
        expect(enter.name === "return" || enter.name === "enter").toBe(true)
        expect(enter.ctrl).toBe(false)
        expect(enter.meta).toBe(false)

        h.pressKey("Alt+Enter")
        await h.renderOnce()
        const alt = captured.at(-1)!
        expect(alt.name === "return" || alt.name === "enter").toBe(true)
        expect(alt.meta === true || alt.option === true).toBe(true)

        h.pressKey("Ctrl+C")
        await h.renderOnce()
        const ctrlC = captured.at(-1)!
        expect(ctrlC.name).toBe("c")
        expect(ctrlC.ctrl).toBe(true)
      } finally {
        shell.dispose()
      }
    })
  })

  test("pending queue badge paints in status", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        })
        try {
          setPendingQueue(shell, 3)
          expect(shell.pendingQueue).toBe(3)
          await h.renderOnce()
          expect(h.captureCharFrame()).toContain("queue 3")
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })
})

describe("list kit + overlay focus simulation", () => {
  test("list viewport keep-active-visible works as overlay consumer", () => {
    let list = createListViewport({ count: 40, height: 8, activeIndex: 0 })
    list = moveActive(list, 20)
    const slice = visibleSlice(list)
    expect(slice.activeIndex).toBe(20)
    expect(slice.start).toBeLessThanOrEqual(20)
    expect(slice.end).toBeGreaterThan(20)
    expect(20 >= slice.start && 20 < slice.end).toBe(true)
  })
})
