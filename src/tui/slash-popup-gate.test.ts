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

        // Filtering keeps working after the refresh.
        press("o")
        expect(shell.prompt.value).toBe("/mo")
        expect(shell.paletteCommands.map((c) => c.id)).toEqual(["model"])
        expect(isSlashPopupOpen(shell)).toBe(true)
        expect(resolved).toBeUndefined()

        // A true dismiss still drains the queue as before.
        press("Escape")
        await Bun.sleep(60)
        expect(shell.overlayKind).toBe("permissions")
        expect(resolved).toBeUndefined()
      } finally {
        dispose()
      }
    })
  })
})
