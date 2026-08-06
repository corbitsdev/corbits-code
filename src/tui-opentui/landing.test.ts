/**
 * Landing anatomy: with no transcript content the screen is the mark, the
 * prompt box and the hint row — no titlebar, no status strip, no filled bars.
 */
import { describe, expect, test } from "bun:test"
import type { CapturedSpan } from "@opentui/core"
import { rgbToHex } from "@opentui/core"
import { withTestRenderer, type Harness } from "./harness"
import { LANDING_MARK, appendStreamRow, createAppShell } from "./shell"

const SIZE = { width: 80, height: 24 } as const

/** Newly added scroll-box children need a layout pass before they paint. */
async function settle(h: Harness): Promise<void> {
  await h.renderOnce()
  await h.renderOnce()
}

function backgrounds(h: Harness): readonly string[] {
  const frame = h.captureSpans()
  return frame.lines.flatMap((line: { spans: CapturedSpan[] }) =>
    line.spans
      .filter((span) => span.text.trim().length > 0 || span.width > 20)
      .map((span) => rgbToHex(span.bg).toLowerCase().slice(0, 7)),
  )
}

function rows(h: Harness): readonly string[] {
  return h.captureCharFrame().split("\n")
}

describe("landing screen", () => {
  test("paints only the mark, the prompt box and the hint row", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        title: "corbits",
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
        run: "idle",
      })
      try {
        await settle(h)
        const painted = rows(h).filter((r) => r.trim().length > 0)

        // Mark is top-anchored, not centered.
        expect(rows(h)[0]?.trim()).toBe(LANDING_MARK)

        const bottom = painted.slice(-5)
        expect(bottom[0]?.trim()).toBe("corbits")
        expect(bottom[1]).toContain("┌")
        expect(bottom[3]).toContain("└")
        expect(bottom[4]?.trim()).toBe("enter send    / commands    @ files")

        // Nothing else: mark, model bar, three prompt rows, hint.
        expect(painted).toHaveLength(6)
      } finally {
        shell.dispose()
      }
    }, SIZE)
  })

  test("no titlebar, status strip or counter row survives", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
        run: "idle",
      })
      try {
        await settle(h)
        const frame = h.captureCharFrame()
        for (const gone of ["BUSY", "IDLE", "FOLLOW", "queue", "lines", "focus"]) {
          expect(frame).not.toContain(gone)
        }
        // The old header blue and status green are gone as fills.
        const fills = new Set(backgrounds(h))
        expect(fills.has("#3d59a1")).toBe(false)
        expect(fills.has("#9ece6a")).toBe(false)
      } finally {
        shell.dispose()
      }
    }, SIZE)
  })

  test("the mark is dropped once the transcript has content", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
      })
      try {
        await settle(h)
        appendStreamRow(shell, { role: "user", text: "first prompt" })
        await settle(h)
        const frame = h.captureCharFrame()
        expect(frame).not.toContain(LANDING_MARK)
        expect(frame).toContain("first prompt")
      } finally {
        shell.dispose()
      }
    }, SIZE)
  })
})
