/**
 * Painted-frame contract for transcript bottom-anchoring: with few rows the
 * content sits against the prompt box below, not stranded at the top of an
 * empty zone; once rows fill the zone, sticky-scroll-to-bottom behaves as
 * before.
 */
import { describe, expect, test } from "bun:test"
import { withTestRenderer } from "./harness"
import { appendStreamRow, createAppShell, type AppShell } from "./shell"

/** Index of the first line whose trimmed content starts with `needle`. */
function lineIndex(frame: string, needle: string): number {
  return frame.split("\n").findIndex((l) => l.trimStart().startsWith(needle))
}

/** Index of the prompt box's top rule (rounded top-left corner). */
function promptTopIndex(frame: string): number {
  return lineIndex(frame, "╭")
}

/** Index of the last non-blank line at or before `promptTop`. */
function lastInkBefore(frame: string, promptTop: number): number {
  const lines = frame.split("\n")
  for (let i = promptTop - 1; i >= 0; i--) {
    if ((lines[i] ?? "").trim().length > 0) return i
  }
  return -1
}

async function paint(
  rowCount: number,
  inspect: (frame: string, shell: AppShell) => void,
): Promise<void> {
  await withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
      })
      try {
        for (let i = 0; i < rowCount; i++) {
          appendStreamRow(shell, { role: "assistant", text: `line ${i}` })
        }
        // Markdown bodies highlight asynchronously.
        await new Promise((resolve) => setTimeout(resolve, 250))
        await h.renderOnce()
        inspect(h.captureCharFrame(), shell)
      } finally {
        shell.dispose()
      }
    },
    { width: 80, height: 24 },
  )
}

describe("transcript bottom-anchoring", () => {
  test("few rows sit directly above the prompt box, empty space above", async () => {
    await paint(3, (frame) => {
      const promptTop = promptTopIndex(frame)
      expect(promptTop).toBeGreaterThan(0)

      // The last painted content row is immediately above the prompt's top rule.
      const lastInk = lastInkBefore(frame, promptTop)
      expect(lastInk).toBe(promptTop - 1)
      expect(frame.split("\n")[lastInk]).toContain("line 2")

      // There is blank space above the content: the zone is not full.
      const firstInk = frame.split("\n").findIndex((l) => l.includes("line 0"))
      expect(firstInk).toBeGreaterThan(1)
    })
  })

  test("enough rows fill the zone and sticky-scroll to bottom holds", async () => {
    await paint(30, (frame, shell) => {
      const promptTop = promptTopIndex(frame)
      const lastInk = lastInkBefore(frame, promptTop)
      expect(lastInk).toBe(promptTop - 1)
      expect(frame.split("\n")[lastInk]).toContain("line 29")

      const max = Math.max(0, shell.transcript.scrollHeight - shell.transcript.height)
      expect(shell.transcript.scrollTop).toBeGreaterThanOrEqual(max - 1)
    })
  })

  test("the row above the newest one holds steady as rows are added", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        })
        try {
          for (let i = 0; i < 3; i++) {
            appendStreamRow(shell, { role: "assistant", text: `line ${i}` })
          }
          await new Promise((resolve) => setTimeout(resolve, 250))
          await h.renderOnce()
          const before = h.captureCharFrame()
          const promptTopBefore = promptTopIndex(before)
          const rowTwoBefore = before.split("\n")[promptTopBefore - 1] ?? ""

          appendStreamRow(shell, { role: "assistant", text: "line 3" })
          await new Promise((resolve) => setTimeout(resolve, 250))
          await h.renderOnce()
          const after = h.captureCharFrame()
          const promptTopAfter = promptTopIndex(after)
          const rowTwoAfter = after.split("\n")[promptTopAfter - 2] ?? ""

          // Row "line 2" keeps its relative position (one above the newest row)
          // rather than the whole block jumping when the newest row lands.
          expect(rowTwoBefore).toContain("line 2")
          expect(rowTwoAfter).toContain("line 2")
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })
})
