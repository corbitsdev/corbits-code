/**
 * CL-5596: a missing surface dependency must produce an honest empty state,
 * never the hardcoded rows from residuals.ts rendered as if they were real.
 */
import { describe, expect, test } from "bun:test"

import { openSettingsSurface, type CommandSurfaceDeps } from "./command-surfaces.js"
import { withTestRenderer } from "./harness.js"
import { createAppShell } from "./shell.js"

describe("overlay dependency gaps never render fixture content", () => {
  test("settings surface without a settings dependency shows no fabricated rows", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          run: "idle",
        })
        try {
          const notified: string[] = []
          const deps: CommandSurfaceDeps = { notify: (text) => notified.push(text) }

          openSettingsSurface(shell, deps)

          expect(shell.overlayItems).not.toContain(
            "Permissions — revoke remembered approvals",
          )
          expect(shell.overlayItems).not.toContain("Compaction — summarize vs drop")
          expect(notified.length).toBeGreaterThan(0)
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })
})
