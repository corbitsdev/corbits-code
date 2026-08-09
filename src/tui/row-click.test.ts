/**
 * The expand arrow is a hit target.
 *
 * It looks like an affordance, so it answers a click: one row, the row that
 * owns the arrow. The row's own text does not — people click text to select
 * and copy it, and a whole-row target would toggle under every drag.
 */
import { describe, expect, test } from "bun:test"

import { withTestRenderer } from "./harness"
import { appendStreamRow, createAppShell } from "./shell"
import { ROW_ARROW, type StreamRow } from "./stream"

const CALL: StreamRow = {
  role: "tool",
  text: "",
  meta: "web_fetch",
  verb: "Web Fetch",
  summary: "https://www.apple.com",
  detail: [[{ text: "url: https://www.apple.com", fg: "#f7ead5" }]],
}

/** Screen position of the first cell of `needle`, or null when it is not painted. */
function findCell(
  frame: string,
  needle: string,
): { readonly x: number; readonly y: number } | null {
  const lines = frame.split("\n")
  for (const [y, line] of lines.entries()) {
    const x = line.indexOf(needle)
    if (x !== -1) return { x, y }
  }
  return null
}

describe("clicking a row's expand arrow", () => {
  test("toggles that row, and clicking its text does not", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        })
        try {
          appendStreamRow(shell, CALL)
          appendStreamRow(shell, { ...CALL, summary: "https://www.example.com" })
          await h.renderOnce()

          const arrow = findCell(h.captureCharFrame(), ROW_ARROW.collapsed)
          expect(arrow).not.toBeNull()

          await h.mockMouse.click(arrow!.x, arrow!.y)
          await h.renderOnce()
          // One row only: the pointer said which.
          expect(shell.streamLog[0]?.expanded).toBe(true)
          expect(shell.streamLog[1]?.expanded).not.toBe(true)

          const open = findCell(h.captureCharFrame(), ROW_ARROW.expanded)
          expect(open).not.toBeNull()
          await h.mockMouse.click(open!.x, open!.y)
          await h.renderOnce()
          expect(shell.streamLog[0]?.expanded).toBe(false)

          const text = findCell(h.captureCharFrame(), "apple.com")
          expect(text).not.toBeNull()
          await h.mockMouse.click(text!.x, text!.y)
          await h.renderOnce()
          expect(shell.streamLog[0]?.expanded).toBe(false)
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })
})
