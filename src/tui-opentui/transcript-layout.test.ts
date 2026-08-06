/**
 * Painted-frame contract for transcript turn layout: where each voice sits on
 * the screen, and that a right-aligned turn stops at the shared gutter.
 */
import { describe, expect, test } from "bun:test"
import { resolveSideMargin } from "./geometry/margins"
import { withTestRenderer } from "./harness"
import {
  appendStreamRow,
  createAppShell,
  shellFocusTranscript,
  type AppShell,
} from "./shell"
import type { StreamRow } from "./stream"

/** Frame rows that carry ink, paired with their index. */
function inkRows(frame: string): readonly string[] {
  return frame.split("\n").filter((row) => row.trim().length > 0)
}

function rowsContaining(frame: string, needle: string): readonly string[] {
  return inkRows(frame).filter((row) => row.includes(needle))
}

async function paintRows(
  rows: readonly StreamRow[],
  columns: number,
  inspect: (frame: string, shell: AppShell) => void,
): Promise<void> {
  await withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns, rows: 24 },
        wireKeys: false,
      })
      try {
        for (const row of rows) appendStreamRow(shell, row)
        // Markdown bodies highlight asynchronously.
        await new Promise((resolve) => setTimeout(resolve, 250))
        await h.renderOnce()
        inspect(h.captureCharFrame(), shell)
      } finally {
        shell.dispose()
      }
    },
    { width: columns, height: 24 },
  )
}

describe("transcript turn layout", () => {
  test("the operator's turn paints flush to the right gutter, never into it", async () => {
    await paintRows([{ role: "user", text: "find the legacy token" }], 80, (frame) => {
      const [row] = rowsContaining(frame, "find the legacy token")
      expect(row).toBeDefined()
      const painted = row as string
      const gutter = resolveSideMargin(80)
      // The gutter stays empty, and the bubble reaches the column beside it.
      expect(painted.slice(80 - gutter).trim()).toBe("")
      expect(painted.trimEnd().length).toBeGreaterThan(80 - gutter - 3)
      expect(painted.trimEnd().length).toBeLessThanOrEqual(80 - gutter)
      // Right-aligned: the turn starts well past the middle of the screen.
      expect(painted.indexOf("▍")).toBeGreaterThan(40)
    })
  })

  test("one agent answers unlabelled, from the left gutter", async () => {
    await paintRows(
      [
        { role: "user", text: "hi" },
        { role: "assistant", text: "listing the directory now" },
      ],
      80,
      (frame) => {
        const [row] = rowsContaining(frame, "listing the directory now")
        expect(row).toBeDefined()
        const painted = row as string
        expect(painted.indexOf("listing")).toBe(resolveSideMargin(80))
        expect(frame).not.toContain("agent")
        expect(frame).not.toContain("you")
      },
    )
  })

  test("a second agent brings icons and names back to the transcript", async () => {
    await paintRows(
      [
        { role: "user", text: "hi" },
        { role: "assistant", text: "on it" },
        { role: "assistant", text: "reviewing", agent: "critic" },
      ],
      80,
      (frame) => {
        expect(frame).toContain("● critic")
        // Relabelling is retroactive: the first answer is named too.
        expect(frame).toContain("● agent")
        // The operator keeps the right gutter regardless.
        const [mine] = rowsContaining(frame, "hi")
        expect((mine as string).indexOf("▍")).toBeGreaterThan(40)
      },
    )
  })

  test("a long operator turn wraps as one right-aligned block", async () => {
    const text =
      "please find every call site of the legacy token helper and tell me which of them still run in production today"
    for (const columns of [50, 64, 80, 120]) {
      await paintRows([{ role: "user", text }], columns, (frame) => {
        const block = inkRows(frame).filter((row) => row.includes("▍"))
        expect(block.length).toBeGreaterThan(1)
        // One rectangle: every line hangs off the same bar column.
        const bars = new Set(block.map((row) => row.indexOf("▍")))
        expect(bars.size).toBe(1)
        const gutter = resolveSideMargin(columns)
        const widest = Math.max(...block.map((row) => row.trimEnd().length))
        expect(widest).toBeLessThanOrEqual(columns - gutter)
        expect(widest).toBeGreaterThan(columns - gutter - 3)
        for (const row of block) {
          expect(row.slice(columns - gutter).trim()).toBe("")
        }
      })
    }
  })

  test("reasoning is an inset, marked block that stays out of the answer's column", async () => {
    await paintRows(
      [
        { role: "user", text: "hi" },
        { role: "system", meta: "thinking", text: "scanning the repo\nthen the call sites" },
        { role: "assistant", text: "found it" },
      ],
      80,
      (frame) => {
        const thinking = inkRows(frame).filter((row) => row.includes("┆"))
        expect(thinking.length).toBe(2)
        const gutter = resolveSideMargin(80)
        for (const row of thinking) {
          expect(row.indexOf("┆")).toBeGreaterThan(gutter)
        }
        const [answer] = rowsContaining(frame, "found it")
        expect((answer as string).indexOf("found it")).toBe(gutter)
      },
    )
  })

  test("a tool call and its result read as one block", async () => {
    await paintRows(
      [
        { role: "tool", text: '"legacy_token"', meta: "grep" },
        { role: "tool", text: "42 matches", meta: "grep", result: true },
      ],
      80,
      (frame) => {
        const [call] = rowsContaining(frame, "legacy_token")
        const [result] = rowsContaining(frame, "42 matches")
        expect(call).toContain("⌕")
        expect(result).toContain("└")
        expect(result).not.toContain("grep")
        expect((result as string).indexOf("42 matches")).toBe(
          (call as string).indexOf('"legacy_token"'),
        )
      },
    )
  })

  test("a loaded skill stays one row until it is expanded", async () => {
    await paintRows(
      [
        {
          role: "tool",
          text: 'Skill "style" — follow these instructions\n\nkeep it clean\nno emojis',
          meta: "use_skill",
          result: true,
          skill: "style",
        },
      ],
      80,
      (frame) => {
        expect(frame).toContain('skill "style" loaded')
        expect(frame).toContain("e expand")
        expect(frame).not.toContain("no emojis")
      },
    )
  })

  test("the expand key opens a collapsed skill while the transcript has focus", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: true,
        })
        try {
          appendStreamRow(shell, {
            role: "tool",
            text: 'Skill "style" — follow these instructions\n\nno emojis',
            meta: "use_skill",
            result: true,
            skill: "style",
          })
          await h.renderOnce()
          expect(h.captureCharFrame()).not.toContain("no emojis")

          // Typing into the prompt must stay typing.
          h.pressKey("e")
          await h.renderOnce()
          expect(h.captureCharFrame()).not.toContain("no emojis")

          shellFocusTranscript(shell)
          h.pressKey("e")
          await h.renderOnce()
          const frame = h.captureCharFrame()
          expect(frame).toContain("no emojis")
          expect(frame).toContain("e collapse")
        } finally {
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })
})
