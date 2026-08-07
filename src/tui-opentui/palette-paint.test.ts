/**
 * Frame-level checks for the command palette's rows: the label, the
 * right-aligned chord, and how the chord degrades at narrow widths.
 */
import { describe, expect, test } from "bun:test"

import type { KeyEvent } from "@opentui/core"

import { withTestRenderer } from "./harness"
import { openModelPickerOverlay } from "./overlays"
import {
  createAppShell,
  handlePaletteFilterKey,
  openPalette,
  type AppShell,
} from "./shell"

async function paletteFrame(width: number): Promise<readonly string[]> {
  return withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: width, rows: 32 },
        wireKeys: false,
        run: "idle",
      })
      openPalette(shell)
      await h.renderOnce()
      return h
        .captureCharFrame()
        .split("\n")
        .map((line) => line.replace(/^\s*│/, "").replace(/│\s*$/, "").trimEnd())
    },
    { width, height: 32 },
  )
}

function rowFor(rows: readonly string[], label: string): string | undefined {
  return rows.find((r) => r.includes(label))
}

describe("command palette rows", () => {
  test("shows the filter prompt with no title rule above it", async () => {
    const rows = await paletteFrame(100)
    expect(rows.some((r) => r.startsWith("─ command palette ─"))).toBe(false)
    expect(rows.some((r) => r.trim() === ">")).toBe(true)
  })

  test("has no leading selection marker or kind column", async () => {
    const rows = await paletteFrame(100)
    const help = rowFor(rows, "Show keymap help")
    expect(help).toBeDefined()
    expect(help).toMatch(/^\s*Show keymap help\s+\?$/)
    expect(help).not.toContain(">")
    expect(help).not.toContain("view")
  })

  test("keeps the right-aligned chord at 100 columns", async () => {
    const rows = await paletteFrame(100)
    const copy = rowFor(rows, "Copy active message / tool")
    expect(copy?.endsWith("Alt+C")).toBe(true)
  })

  test("drops the chord at a narrow width, and the label always survives", async () => {
    const rows = await paletteFrame(36)
    const help = rowFor(rows, "Show keymap help")
    expect(help).toBeDefined()
    expect(help?.endsWith("?")).toBe(false)

    const copy = rowFor(rows, "Copy active")
    expect(copy?.includes("Alt+C")).toBe(false)
  })
})

describe("palette filters as you type", () => {
  function withPalette(
    fn: (shell: AppShell) => void,
    width = 100,
  ): Promise<void> {
    return withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: width, rows: 32 },
          wireKeys: false,
          run: "idle",
        })
        try {
          openPalette(shell, { typeToFilter: true })
          fn(shell)
        } finally {
          shell.dispose()
        }
      },
      { width, height: 32 },
    )
  }

  function press(shell: AppShell, seq: string): boolean {
    return handlePaletteFilterKey(shell, {
      name: seq,
      sequence: seq,
      ctrl: false,
      meta: false,
      option: false,
    } as unknown as KeyEvent)
  }

  const BACKSPACE = {
    name: "backspace",
    sequence: "",
    ctrl: false,
    meta: false,
    option: false,
  } as unknown as KeyEvent

  test("printable keys narrow the list and show in the query row", async () => {
    await withPalette((shell) => {
      const all = shell.paletteCommands.length
      expect(press(shell, "m")).toBe(true)
      press(shell, "o")
      press(shell, "d")
      expect(shell.paletteCommands.length).toBeLessThan(all)
      expect(shell.paletteCommands.some((c) => c.id === "model_picker")).toBe(
        true,
      )
      expect(shell.overlayBodyLines[0]).toBe("> mod")
    })
  })

  test("backspace widens the list again", async () => {
    await withPalette((shell) => {
      press(shell, "m")
      press(shell, "o")
      press(shell, "d")
      const narrowed = shell.paletteCommands.length
      expect(handlePaletteFilterKey(shell, BACKSPACE)).toBe(true)
      expect(handlePaletteFilterKey(shell, BACKSPACE)).toBe(true)
      expect(shell.paletteCommands.length).toBeGreaterThan(narrowed)
      expect(shell.overlayBodyLines[0]).toBe("> m")
    })
  })

  test("j and k type into the query instead of navigating", async () => {
    await withPalette((shell) => {
      const before = shell.overlayList?.activeIndex
      expect(press(shell, "j")).toBe(true)
      expect(shell.overlayList?.activeIndex).toBe(before ?? 0)
      expect(shell.overlayBodyLines[0]).toBe("> j")
    })
  })

  test("arrow and page keys are left to the overlay", async () => {
    await withPalette((shell) => {
      for (const name of ["down", "up", "pagedown", "pageup", "return"]) {
        const key = {
          name,
          sequence: "",
          ctrl: false,
          meta: false,
          option: false,
        } as unknown as KeyEvent
        expect(handlePaletteFilterKey(shell, key)).toBe(false)
      }
    })
  })

  test("a query matching nothing leaves the palette open and empty", async () => {
    await withPalette((shell) => {
      for (const ch of "zzqq") press(shell, ch)
      expect(shell.paletteCommands).toEqual([])
      expect(shell.overlayItems).toEqual(["(no matches)"])
      expect(shell.overlayKind).toBe("palette")
    })
  })

  test("other overlays keep j/k navigation", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 100, rows: 32 },
          wireKeys: false,
          run: "idle",
        })
        try {
          openModelPickerOverlay(shell)
          expect(press(shell, "j")).toBe(false)
        } finally {
          shell.dispose()
        }
      },
      { width: 100, height: 32 },
    )
  })
})

describe("command palette width", () => {
  // Both boxes are children of the same padded root; a width computed a
  // second way for the floating palette drifts from the prompt box's "100%".
  test("shares the prompt box's left/right edges while floating over landing", async () => {
    const rows = await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        })
        openPalette(shell)
        await h.renderOnce()
        return h.captureCharFrame().split("\n")
      },
      { width: 80, height: 24 },
    )
    const overlayTop = rows.find((r) => r.includes("┌"))
    const promptTop = rows.find((r) => r.includes("╭"))
    expect(overlayTop).toBeDefined()
    expect(promptTop).toBeDefined()
    expect(overlayTop?.indexOf("┌")).toBe(promptTop?.indexOf("╭"))
    expect(overlayTop?.lastIndexOf("┐")).toBe(promptTop?.lastIndexOf("╮"))
  })
})

