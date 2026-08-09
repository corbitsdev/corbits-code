/**
 * Integration: `/` command popup and the double Ctrl+C exit, both driven
 * through the wired key path on a headless shell.
 */
import { describe, expect, test } from "bun:test"

import { withTestRenderer } from "./harness"
import type { PaletteCommand } from "./command-catalog"
import {
  CTRL_C_EXIT_WINDOW_MS,
  createAppShell,
  handleCtrlC,
  isSlashPopupOpen,
  noticeText,
  setShellExitHandler,
  setShellRunState,
  setStatusFlash,
  type AppShell,
} from "./shell"

const CATALOG: readonly PaletteCommand[] = [
  { id: "model", label: "/model — switch model" },
  { id: "mcp", label: "/mcp — manage MCP servers" },
  { id: "compact", label: "/compact — compact history" },
]

type Ctx = {
  readonly shell: AppShell
  readonly dispatched: string[]
  readonly press: (key: string) => void
  readonly render: () => Promise<void>
}

function withShell(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  return withTestRenderer(
    async (h) => {
      const dispatched: string[] = []
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: true,
        run: "idle",
        paletteCatalog: CATALOG,
        onCommand: (name) => dispatched.push(name),
      })
      try {
        await fn({
          shell,
          dispatched,
          press: (key) => h.pressKey(key as Parameters<typeof h.pressKey>[0]),
          render: h.renderOnce,
        })
      } finally {
        shell.dispose()
      }
    },
    { width: 80, height: 24 },
  )
}

describe("slash command popup", () => {
  test("typing / at an empty prompt opens the command list", async () => {
    await withShell(async ({ shell, press, render }) => {
      press("/")
      await render()
      expect(shell.prompt.value).toBe("/")
      expect(shell.overlayKind).toBe("palette")
      expect(isSlashPopupOpen(shell)).toBe(true)
      expect(shell.paletteCommands).toHaveLength(CATALOG.length)
    })
  })

  test("further characters filter the list", async () => {
    await withShell(async ({ shell, press }) => {
      press("/")
      press("m")
      expect(shell.prompt.value).toBe("/m")
      expect(shell.paletteCommands.map((c) => c.id)).toEqual(["model", "mcp"])
      press("o")
      expect(shell.prompt.value).toBe("/mo")
      expect(shell.paletteCommands.map((c) => c.id)).toEqual(["model"])
    })
  })

  test("backspace widens the filter again", async () => {
    await withShell(async ({ shell, press }) => {
      press("/")
      press("m")
      press("o")
      press("Backspace")
      expect(shell.prompt.value).toBe("/m")
      expect(shell.paletteCommands.map((c) => c.id)).toEqual(["model", "mcp"])
    })
  })

  test("Esc cancels and leaves the typed text intact", async () => {
    await withShell(async ({ shell, press, render }) => {
      press("/")
      press("m")
      press("Escape")
      // A bare ESC is held by the input parser until it cannot be a sequence.
      await render()
      await Bun.sleep(60)
      expect(isSlashPopupOpen(shell)).toBe(false)
      expect(shell.overlayList).toBeNull()
      expect(shell.prompt.value).toBe("/m")
    })
  })

  test("Enter dispatches through the registry command path", async () => {
    await withShell(async ({ shell, dispatched, press }) => {
      press("/")
      press("m")
      press("o")
      press("Enter")
      expect(dispatched).toEqual(["model"])
      expect(shell.prompt.value).toBe("")
      expect(shell.overlayList).toBeNull()
    })
  })

  test("Tab completes the name so arguments can be typed", async () => {
    await withShell(async ({ shell, dispatched, press }) => {
      press("/")
      press("m")
      press("c")
      press("Tab")
      expect(dispatched).toEqual([])
      expect(shell.prompt.value).toBe("/mcp ")
      expect(isSlashPopupOpen(shell)).toBe(false)
    })
  })

  test("a space closes the popup and keeps the prompt editable", async () => {
    await withShell(async ({ shell, press }) => {
      press("/")
      press("m")
      press("c")
      press("p")
      press(" ")
      expect(shell.prompt.value).toBe("/mcp ")
      expect(isSlashPopupOpen(shell)).toBe(false)
    })
  })

  test("/ mid-prompt is a literal character", async () => {
    await withShell(async ({ shell, press }) => {
      press("s")
      press("r")
      press("c")
      press("/")
      expect(isSlashPopupOpen(shell)).toBe(false)
      expect(shell.prompt.value).toBe("src/")
    })
  })
})

describe("Ctrl+C exit", () => {
  test("first press interrupts a busy run, second exits via the handler", async () => {
    await withShell(async ({ shell, press }) => {
      setShellRunState(shell, "busy")
      let exits = 0
      setShellExitHandler(shell, () => {
        exits += 1
      })
      press("Ctrl+C")
      expect(exits).toBe(0)
      expect(shell.session.run).not.toBe("busy")
      press("Ctrl+C")
      expect(exits).toBe(1)
    })
  })

  test("the exit notice clears itself when the arming window lapses", async () => {
    await withShell(async ({ shell }) => {
      const lapse: (() => void)[] = []
      handleCtrlC(shell, 0, {
        schedule: (fn, ms) => {
          expect(ms).toBe(CTRL_C_EXIT_WINDOW_MS)
          lapse.push(fn)
          return () => {}
        },
      })
      expect(shell.statusFlash).toBe("press ctrl+c again to exit")
      expect(noticeText(shell)).toContain("press ctrl+c again to exit")

      lapse[0]?.()
      expect(shell.statusFlash).toBeNull()
      // The row has nothing left to say, so it is given back to the transcript.
      expect(noticeText(shell)).toBe("")
    })
  })

  test("a lapsed window never clears a flash set after it", async () => {
    await withShell(async ({ shell }) => {
      const lapse: (() => void)[] = []
      handleCtrlC(shell, 0, {
        schedule: (fn) => {
          lapse.push(fn)
          return () => {}
        },
      })
      setStatusFlash(shell, "copied 3 lines")
      lapse[0]?.()
      expect(shell.statusFlash).toBe("copied 3 lines")
    })
  })

  test("a press outside the window re-arms instead of exiting", async () => {
    await withShell(async ({ shell }) => {
      let exits = 0
      setShellExitHandler(shell, () => {
        exits += 1
      })
      handleCtrlC(shell, 0)
      handleCtrlC(shell, CTRL_C_EXIT_WINDOW_MS + 1)
      expect(exits).toBe(0)
      handleCtrlC(shell, CTRL_C_EXIT_WINDOW_MS + 2)
      expect(exits).toBe(1)
    })
  })
})
