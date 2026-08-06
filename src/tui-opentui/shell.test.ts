/**
 * Integration: app shell product skin — sticky, queue/steer/interrupt, overlay Esc.
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
import { paintStreamRow } from "./stream"
import {
  appendStreamRow,
  appendTranscript,
  closeInsetOverlay,
  createAppShell,
  interruptShell,
  isTranscriptFollowing,
  openInsetOverlay,
  setPendingQueue,
  shellFocusPrompt,
  shellFocusTranscript,
  stickyMode,
  submitPrompt,
  toggleShellFocus,
} from "./shell"

/** Last painted row: the hint line is the bottom-most chrome in every state. */
function hintLine(frame: string): string {
  const rows = frame.split("\n").filter((r) => r.trim().length > 0)
  return rows.at(-1) ?? ""
}

describe("createAppShell", () => {
  test("builds transcript / prompt / hint with floor geometry", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          title: "test",
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        })
        try {
          expect(shell.transcript).toBeDefined()
          expect(shell.prompt).toBeDefined()
          expect(shell.hint).toBeDefined()
          expect(shell.transcript.stickyScroll).toBe(true)
          expect(shell.layout.transcriptHeight).toBeGreaterThanOrEqual(
            IDLE_TRANSCRIPT_FLOOR,
          )
          expect(focusOwner(shell.focus)).toBe("prompt")
          expect(scrollLease(shell.focus)).toBe("transcript")
          await h.renderOnce()
          const frame = h.captureCharFrame()
          expect(frame).toContain("test")
          expect(frame).toContain("enter send")
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
          expect(h.captureCharFrame()).toContain("tab prompt")
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

describe("product skin: stream + queue + overlay", () => {
  test("transcript rows carry no line-number gutter", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        })
        try {
          appendStreamRow(shell, { role: "tool", text: "ok", meta: "bash" })
          appendStreamRow(shell, { role: "user", text: "hello world" })
          await h.renderOnce()
          const frame = h.captureCharFrame()
          expect(frame).toContain("hello world")
          expect(frame).not.toMatch(/000[12]/)
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("stream rows paint distinct role labels", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        })
        try {
          appendStreamRow(shell, { role: "user", text: "hello world" })
          appendStreamRow(shell, { role: "assistant", text: "hi there" })
          appendStreamRow(shell, {
            role: "tool",
            text: "ok",
            meta: "bash",
          })
          expect(shell.lineCount).toBe(3)
          // Assistant rows are markdown; their blocks highlight asynchronously.
          await new Promise((resolve) => setTimeout(resolve, 250))
          await h.renderOnce()
          const frame = h.captureCharFrame()
          // Sticky follows the tail — last roles stay in view.
          expect(frame).toContain("agent")
          expect(frame).toContain("hi there")
          expect(frame).toContain("tool")
          expect(frame).toContain("bash")
          // User row content is in the scroll buffer (pure paint covered in stream.test).
          expect(paintStreamRow({ role: "user", text: "hello world" }).content).toContain(
            "you",
          )
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("hint line shows the keys that work right now", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        })
        try {
          await h.renderOnce()
          const frame = h.captureCharFrame()
          expect(frame).toContain("enter send")
          expect(frame).toContain("/ commands")
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("busy Enter enqueues; badge increments", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        })
        try {
          shell.prompt.value = "queue me"
          submitPrompt(shell, "queue")
          expect(shell.pendingQueue).toBe(1)
          expect(shell.session.items[0]!.kind).toBe("queue")
          expect(shell.prompt.value).toBe("")
          await h.renderOnce()
          expect(h.captureCharFrame()).toContain("queue 1")
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("busy Alt+Enter steers", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        })
        try {
          shell.prompt.value = "steer me"
          submitPrompt(shell, "steer")
          expect(shell.pendingQueue).toBe(1)
          expect(shell.session.items[0]!.kind).toBe("steer")
          await h.renderOnce()
          await h.renderOnce()
          const frame = h.captureCharFrame()
          expect(frame).toContain("steer")
          expect(frame).toContain("queue 1")
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("Ctrl+C interrupt clears pending + flash", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        })
        try {
          shell.prompt.value = "a"
          submitPrompt(shell, "queue")
          shell.prompt.value = "b"
          submitPrompt(shell, "steer")
          expect(shell.pendingQueue).toBe(2)
          interruptShell(shell)
          expect(shell.pendingQueue).toBe(0)
          expect(shell.session.interruptFlash).toBe(true)
          expect(shell.session.run).toBe("idle")
          await h.renderOnce()
          const hintRow = hintLine(h.captureCharFrame())
          expect(hintRow).toContain("interrupt")
          // An empty queue is the default state, so it stays off the hint row.
          expect(hintRow).not.toContain("queue")
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("inset overlay opens; Esc restores prompt focus", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        })
        try {
          expect(focusOwner(shell.focus)).toBe("prompt")
          openInsetOverlay(shell)
          expect(shell.overlayList).not.toBeNull()
          expect(focusOwner(shell.focus)).toBe("overlay")
          expect(shell.layout.overlayMode).toBe("inset")
          expect(shell.overlayHost.visible).toBe(true)
          await h.renderOnce()
          const openFrame = h.captureCharFrame()
          expect(openFrame).toContain("permission")
          expect(openFrame).toContain("Allow bash")

          closeInsetOverlay(shell)
          expect(shell.overlayList).toBeNull()
          expect(focusOwner(shell.focus)).toBe("prompt")
          expect(shell.layout.overlayMode).toBe("closed")
          await h.renderOnce()
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("Esc key closes overlay via wireKeys", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
        })
        try {
          openInsetOverlay(shell)
          expect(focusOwner(shell.focus)).toBe("overlay")
          // ESC needs disambiguation delay on the mock stdin path.
          h.pressKey("Escape")
          await new Promise((r) => setTimeout(r, 60))
          await h.renderOnce()
          expect(shell.overlayList).toBeNull()
          expect(focusOwner(shell.focus)).toBe("prompt")
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("80x24 idle transcript floor holds with closed overlay", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        })
        try {
          expect(shell.layout.transcriptHeight).toBeGreaterThanOrEqual(
            IDLE_TRANSCRIPT_FLOOR,
          )
          openInsetOverlay(shell)
          // Inset may shrink transcript but still uses resolver floors.
          expect(shell.layout.overlayHeight).toBeGreaterThan(0)
          closeInsetOverlay(shell)
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

describe("prompt editing chords", () => {
  test("Ctrl+K kills to end of prompt, Ctrl+Y yanks it back", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
        })
        try {
          shell.prompt.value = "hello world"
          shell.prompt.cursorOffset = 5
          h.pressKey("k", { ctrl: true })
          await h.renderOnce()
          expect(shell.prompt.value).toBe("hello")

          h.pressKey("y", { ctrl: true })
          await h.renderOnce()
          expect(shell.prompt.value).toBe("hello world")
          expect(shell.prompt.cursorOffset).toBe(11)
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("Ctrl+U kills to start of prompt (backward)", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
        })
        try {
          shell.prompt.value = "hello world"
          shell.prompt.cursorOffset = 6
          h.pressKey("u", { ctrl: true })
          await h.renderOnce()
          expect(shell.prompt.value).toBe("world")
          expect(shell.prompt.cursorOffset).toBe(0)

          h.pressKey("y", { ctrl: true })
          await h.renderOnce()
          expect(shell.prompt.value).toBe("hello world")
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("Ctrl+W kills the previous word", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
        })
        try {
          shell.prompt.value = "hello world"
          shell.prompt.cursorOffset = 11
          h.pressKey("w", { ctrl: true })
          await h.renderOnce()
          expect(shell.prompt.value).toBe("hello ")

          h.pressKey("y", { ctrl: true })
          await h.renderOnce()
          expect(shell.prompt.value).toBe("hello world")
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("Alt+D kills the next word", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
        })
        try {
          shell.prompt.value = "hello world"
          shell.prompt.cursorOffset = 0
          h.pressKey("d", { meta: true })
          await h.renderOnce()
          // The native deleteWordForward consumes the trailing separator too.
          expect(shell.prompt.value).toBe("world")

          h.pressKey("y", { ctrl: true })
          await h.renderOnce()
          expect(shell.prompt.value).toBe("hello world")
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("a no-op Ctrl+K (already at end) does not clobber the prior kill", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
        })
        try {
          shell.prompt.value = "one two three"
          shell.prompt.cursorOffset = 3
          h.pressKey("k", { ctrl: true })
          await h.renderOnce()
          expect(shell.prompt.value).toBe("one")

          // Cursor is already at the end of the buffer, so this Ctrl+K kills
          // nothing — it must not overwrite the ring with an empty entry.
          h.pressKey("k", { ctrl: true })
          await h.renderOnce()
          expect(shell.prompt.value).toBe("one")

          h.pressKey("y", { ctrl: true })
          await h.renderOnce()
          expect(shell.prompt.value).toBe("one two three")
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("Alt+Y rotates the yank to the next-older kill", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
        })
        try {
          shell.prompt.value = "first second"
          shell.prompt.cursorOffset = 12
          h.pressKey("w", { ctrl: true })
          await h.renderOnce()
          expect(shell.prompt.value).toBe("first ")

          // A non-kill keystroke breaks accumulation so the next kill lands
          // in a fresh ring entry instead of merging with this one.
          h.pressKey("ARROW_LEFT")
          await h.renderOnce()
          shell.prompt.cursorOffset = 0

          h.pressKey("k", { ctrl: true })
          await h.renderOnce()
          expect(shell.prompt.value).toBe("")

          h.pressKey("y", { ctrl: true })
          await h.renderOnce()
          expect(shell.prompt.value).toBe("first ")

          h.pressKey("y", { meta: true })
          await h.renderOnce()
          expect(shell.prompt.value).toBe("second")
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })

  test("typing between kills breaks accumulation: a later Ctrl+K starts a fresh entry", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
        })
        try {
          shell.prompt.value = "one two"
          shell.prompt.cursorOffset = 3
          h.pressKey("k", { ctrl: true })
          await h.renderOnce()
          expect(shell.prompt.value).toBe("one")

          h.pressKey("x")
          await h.renderOnce()
          expect(shell.prompt.value).toBe("onex")

          h.pressKey("Backspace")
          await h.renderOnce()
          expect(shell.prompt.value).toBe("one")

          h.pressKey("y", { ctrl: true })
          await h.renderOnce()
          // The kill ring still has " two" from the original Ctrl+K — typing
          // and backspacing in between must not have merged into it.
          expect(shell.prompt.value).toBe("one two")
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
