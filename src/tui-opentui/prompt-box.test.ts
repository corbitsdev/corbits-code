/**
 * Integration: the prompt box as a multi-line composing area, and the openers
 * that toggle their surface shut when pressed a second time.
 */
import { describe, expect, test } from "bun:test"

import { PROMPT_KEY_BINDINGS } from "./prompt-input"
import { withTestRenderer, type Harness } from "./harness"
import {
  PROMPT_BASE_ROWS,
  PROMPT_CAP_FRACTION,
  PROMPT_IDLE_ROWS,
} from "./geometry/index.js"
import { focusOwner } from "./focus/index.js"
import { promptCaretRow, promptRowCount } from "./prompt-input.js"
import {
  appendStreamRow,
  closeInsetOverlay,
  createAppShell,
  toggleShellFocus,
  type AppShell,
} from "./shell"
import { openPermissionsOverlay } from "./overlays"

function withShell(
  size: { readonly columns: number; readonly rows: number },
  fn: (shell: AppShell, h: Harness) => Promise<void> | void,
): Promise<void> {
  return withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: size.columns, rows: size.rows },
        wireKeys: true,
        run: "idle",
      })
      try {
        await fn(shell, h)
      } finally {
        shell.dispose()
      }
    },
    { width: size.columns, height: size.rows },
  )
}

/** The wrapped-line table is rebuilt during layout, so compose then render. */
async function compose(
  shell: AppShell,
  h: Harness,
  value: string,
): Promise<void> {
  shell.prompt.value = value
  await h.renderOnce()
  await h.renderOnce()
}

function lines(count: number): string {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n")
}

describe("prompt box height", () => {
  test("rests taller than a single input line on every usable terminal", async () => {
    for (const rows of [24, 30, 48]) {
      await withShell({ columns: 80, rows }, (shell) => {
        expect(shell.layout.heights.prompt).toBe(PROMPT_IDLE_ROWS)
        expect(shell.promptField.height).toBe(PROMPT_IDLE_ROWS - 2)
      })
    }
  })

  test("grows with the lines being composed", async () => {
    await withShell({ columns: 80, rows: 40 }, async (shell, h) => {
      await compose(shell, h, lines(6))
      expect(promptRowCount(shell.prompt)).toBe(6)
      expect(shell.layout.heights.prompt).toBe(8)
      expect(shell.prompt.height).toBe(6)
    })
  })

  test("wrapped text counts as rows, not one long line", async () => {
    await withShell({ columns: 80, rows: 40 }, async (shell, h) => {
      await compose(shell, h, "w".repeat(400))
      expect(promptRowCount(shell.prompt)).toBeGreaterThan(3)
      expect(shell.layout.heights.prompt).toBe(
        promptRowCount(shell.prompt) + 2,
      )
    })
  })

  test("stops growing at the cap fraction and scrolls instead", async () => {
    await withShell({ columns: 80, rows: 40 }, async (shell, h) => {
      const cap = Math.floor(40 * PROMPT_CAP_FRACTION)
      await compose(shell, h, lines(60))
      expect(shell.layout.heights.prompt).toBe(cap)
      // Content outlives the window: the editor view scrolls the caret into
      // view rather than the frame continuing to open.
      expect(promptRowCount(shell.prompt)).toBeGreaterThan(cap)
      expect(shell.prompt.height).toBe(cap - 2)
    })
  })

  test("shrinks back toward the base box on a terminal too short for both", async () => {
    await withShell({ columns: 80, rows: 16 }, (shell) => {
      expect(shell.layout.heights.prompt).toBeLessThan(PROMPT_IDLE_ROWS)
      expect(shell.layout.heights.prompt).toBeGreaterThanOrEqual(
        PROMPT_BASE_ROWS,
      )
      expect(shell.layout.transcriptHeight).toBeGreaterThanOrEqual(
        shell.layout.transcriptFloor,
      )
    })
  })

  test("the transcript floor outranks the composing area, however much is typed", async () => {
    for (const rows of [16, 20, 24, 40]) {
      await withShell({ columns: 80, rows }, async (shell, h) => {
        await compose(shell, h, lines(80))
        expect(shell.layout.transcriptHeight).toBeGreaterThanOrEqual(
          shell.layout.transcriptFloor,
        )
        expect(shell.layout.heights.prompt).toBeGreaterThanOrEqual(
          PROMPT_BASE_ROWS,
        )
      })
    }
  })

  test("the box stays anchored at the foot of the terminal", async () => {
    await withShell({ columns: 80, rows: 30 }, async (shell, h) => {
      await compose(shell, h, lines(5))
      const box = shell.layout.regions.prompt
      expect(box).toBeDefined()
      expect(box!.y + box!.height).toBe(30)
    })
  })
})

describe("prompt caret vs sent-message recall", () => {
  test("Up walks the caret up the rows before it reaches history", async () => {
    await withShell({ columns: 80, rows: 30 }, async (shell, h) => {
      await compose(shell, h, "alpha\nbeta\ngamma")
      shell.prompt.cursorOffset = shell.prompt.value.length
      shell.prompt.focus()
      expect(promptCaretRow(shell.prompt)).toBe(2)

      h.pressKey("ARROW_UP")
      expect(promptCaretRow(shell.prompt)).toBe(1)
      expect(shell.prompt.value).toBe("alpha\nbeta\ngamma")

      h.pressKey("ARROW_UP")
      expect(promptCaretRow(shell.prompt)).toBe(0)
      expect(shell.prompt.value).toBe("alpha\nbeta\ngamma")
    })
  })

  test("Down walks back down without recalling mid-buffer", async () => {
    await withShell({ columns: 80, rows: 30 }, async (shell, h) => {
      await compose(shell, h, "alpha\nbeta\ngamma")
      shell.prompt.cursorOffset = 0
      shell.prompt.focus()

      h.pressKey("ARROW_DOWN")
      expect(promptCaretRow(shell.prompt)).toBe(1)
      expect(shell.prompt.value).toBe("alpha\nbeta\ngamma")
    })
  })
})

describe("Enter is still the send key", () => {
  test("Enter sends; Ctrl+J opens a new line instead", async () => {
    await withShell({ columns: 80, rows: 30 }, async (shell, h) => {
      await compose(shell, h, "first")
      shell.prompt.focus()

      h.pressKey("LINEFEED")
      expect(shell.prompt.value).toBe("first\n")

      h.pressKey("Enter")
      expect(shell.prompt.value).toBe("")
    })
  })

  test("the newline binding is qualified ahead of the bare submit", () => {
    // A first-match table would otherwise resolve Shift+Enter against the bare
    // `return` submit entry. Whether the modifier ever arrives is the
    // terminal's business — without the kitty keyboard protocol both Enter and
    // Shift+Enter are a bare CR — so this asserts the table, not the chord.
    const names = PROMPT_KEY_BINDINGS.map((b) => `${b.name}:${String("shift" in b)}`)
    expect(names.indexOf("return:true")).toBeLessThan(names.indexOf("return:false"))
    expect(names.indexOf("kpenter:true")).toBeLessThan(names.indexOf("kpenter:false"))
  })
})

describe("openers toggle their surface shut", () => {
  test("Ctrl+O opens the palette and closes it", async () => {
    await withShell({ columns: 80, rows: 30 }, (shell, h) => {
      h.pressKey("o", { ctrl: true })
      expect(shell.overlayKind).toBe("palette")
      expect(focusOwner(shell.focus)).toBe("palette")

      h.pressKey("o", { ctrl: true })
      expect(shell.overlayKind).toBeNull()
      expect(shell.overlayList).toBeNull()
      expect(focusOwner(shell.focus)).not.toBe("palette")
    })
  })

  test("Alt+C opens copy mode and closes it", async () => {
    await withShell({ columns: 80, rows: 30 }, (shell, h) => {
      appendStreamRow(shell, { role: "assistant", text: "something to copy" })
      h.pressKey("c", { meta: true })
      expect(shell.overlayKind).toBe("copy")

      h.pressKey("c", { meta: true })
      expect(shell.overlayKind).toBeNull()
      expect(shell.copyTargets).toBeNull()
    })
  })

  test("? opens the shortcut list and closes it", async () => {
    await withShell({ columns: 80, rows: 30 }, (shell, h) => {
      toggleShellFocus(shell)
      h.pressKey("?")
      expect(shell.overlayKind).toBe("help")

      h.pressKey("?")
      expect(shell.overlayKind).toBeNull()
    })
  })

  test("an opener cannot dismiss an approval overlay", async () => {
    await withShell({ columns: 80, rows: 30 }, (shell, h) => {
      openPermissionsOverlay(shell)
      expect(shell.overlayKind).toBe("permissions")

      // A decision surface leaves by a choice or Esc, never because some other
      // opener happened to be pressed.
      h.pressKey("o", { ctrl: true })
      expect(shell.overlayKind).toBe("permissions")
      h.pressKey("c", { meta: true })
      expect(shell.overlayKind).toBe("permissions")
      h.pressKey("?")
      expect(shell.overlayKind).toBe("permissions")

      closeInsetOverlay(shell)
      expect(shell.overlayKind).toBeNull()
    })
  })
})
