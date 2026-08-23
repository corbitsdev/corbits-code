/**
 * CL-6699: a queued permission/operator gate must not open onto the host in
 * the middle of a `/` command filter session. The old close-then-reopen
 * refresh (closeSlashPopup -> closeInsetOverlay -> notifyOverlayClosed)
 * released the host between the two calls, and a gate queued behind the
 * popup drained into that gap.
 */
import { EventEmitter } from "node:events"
import { describe, expect, test } from "bun:test"

import { withTestRenderer } from "./harness"
import type { PaletteCommand } from "./command-catalog"
import { wireGates } from "./gate-wire"
import {
  createAppShell,
  isSlashPopupOpen,
  onOverlayClosed,
  type AppShell,
} from "./shell"

const CATALOG: readonly PaletteCommand[] = [
  {
    id: "model",
    label: "/model",
    description: "Open model picker",
    keywords: ["model", "Open model picker", "slash", "command"],
  },
  { id: "mcp", label: "/mcp" },
  { id: "compact", label: "/compact" },
]

type Ctx = {
  readonly shell: AppShell
  readonly press: (key: string) => void
  readonly render: () => Promise<void>
}

function withShell(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  return withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: true,
        run: "idle",
        paletteCatalog: CATALOG,
      })
      try {
        await fn({
          shell,
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

describe("/ popup keeps a queued gate queued across a filter refresh", () => {
  test("filter keystroke while a gate is queued", async () => {
    await withShell(async ({ shell, press }) => {
      const emitter = new EventEmitter()
      const dispose = wireGates(emitter, shell)
      // The host closing (onOverlayClosed) is what the queued gate waits
      // on to drain — see gate-wire.ts's onOverlayClosed/pending. Under the
      // old close-then-reopen refresh this fires on every filter keystroke
      // (closeSlashPopup -> closeInsetOverlay -> notifyOverlayClosed) even
      // though the palette immediately re-stacks on top and every assertion
      // on shell.overlayKind alone sees only "palette" again by the time it
      // runs. Counting this call directly is what actually distinguishes
      // the in-place refresh from the old close+reopen one.
      let closedCount = 0
      const disposeClosedSpy = onOverlayClosed(shell, () => {
        closedCount++
      })
      try {
        press("/")
        expect(isSlashPopupOpen(shell)).toBe(true)
        expect(shell.overlayKind).toBe("palette")

        let resolved: unknown
        emitter.emit("permission.gate", {
          request: {
            tool: "run_shell",
            action: "Run shell command",
            subject: "bun test",
            scopes: [],
          },
          resolve: (outcome: unknown) => {
            resolved = outcome
          },
        })

        // Queued, not opened — the slash popup still owns the host.
        expect(shell.overlayKind).toBe("palette")
        expect(resolved).toBeUndefined()
        expect(closedCount).toBe(0)

        // Refreshing the filter must not release the host to the queued gate.
        press("m")
        expect(shell.prompt.value).toBe("/m")
        expect(shell.overlayKind).toBe("palette")
        expect(isSlashPopupOpen(shell)).toBe(true)
        expect(shell.paletteCommands.map((c) => c.id)).toEqual([
          "model",
          "mcp",
        ])
        expect(resolved).toBeUndefined()
        expect(closedCount).toBe(0)

        // Filtering keeps working after the refresh.
        press("o")
        expect(shell.prompt.value).toBe("/mo")
        expect(shell.paletteCommands.map((c) => c.id)).toEqual(["model"])
        expect(isSlashPopupOpen(shell)).toBe(true)
        expect(resolved).toBeUndefined()
        expect(closedCount).toBe(0)

        // A keystroke that drops matches to zero must not dismiss the popup
        // either — it stays owned with a "(no matches)" row, and the gate
        // stays queued behind it.
        press("z")
        expect(shell.prompt.value).toBe("/moz")
        expect(isSlashPopupOpen(shell)).toBe(true)
        expect(shell.overlayKind).toBe("palette")
        expect(shell.paletteCommands).toEqual([])
        expect(shell.overlayItems).toEqual(["(no matches)"])
        expect(resolved).toBeUndefined()
        expect(closedCount).toBe(0)

        // A backspace that restores matches refreshes back in place too.
        press("Backspace")
        expect(shell.prompt.value).toBe("/mo")
        expect(shell.paletteCommands.map((c) => c.id)).toEqual(["model"])
        expect(isSlashPopupOpen(shell)).toBe(true)
        expect(resolved).toBeUndefined()
        expect(closedCount).toBe(0)

        // A true dismiss still drains the queue as before.
        press("Escape")
        await Bun.sleep(60)
        expect(shell.overlayKind).toBe("permissions")
        expect(resolved).toBeUndefined()
        expect(closedCount).toBe(1)
      } finally {
        disposeClosedSpy()
        dispose()
      }
    })
  })

  test("Enter on zero matches closes the popup, keeps the typed text, and drains a queued gate", async () => {
    await withShell(async ({ shell, press }) => {
      const emitter = new EventEmitter()
      const dispose = wireGates(emitter, shell)
      const disposeClosedSpy = onOverlayClosed(shell, () => {})
      try {
        press("/")
        press("m")
        press("o")
        press("z")
        expect(shell.prompt.value).toBe("/moz")
        expect(shell.paletteCommands).toEqual([])
        expect(isSlashPopupOpen(shell)).toBe(true)

        let resolved: unknown
        emitter.emit("permission.gate", {
          request: {
            tool: "run_shell",
            action: "Run shell command",
            subject: "bun test",
            scopes: [],
          },
          resolve: (outcome: unknown) => {
            resolved = outcome
          },
        })
        expect(shell.overlayKind).toBe("palette")
        expect(resolved).toBeUndefined()

        // Enter with no active command must not wipe the typed text.
        press("Enter")
        expect(isSlashPopupOpen(shell)).toBe(false)
        expect(shell.prompt.value).toBe("/moz")

        // Popup close is a genuine dismiss: the queued gate drains onto it.
        await Bun.sleep(60)
        expect(shell.overlayKind).toBe("permissions")
        expect(resolved).toBeUndefined()
      } finally {
        disposeClosedSpy()
        dispose()
      }
    })
  })
})
