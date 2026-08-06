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
  test("the operator's turn paints flush to the left gutter, bar first", async () => {
    await paintRows([{ role: "user", text: "find the legacy token" }], 80, (frame) => {
      const [row] = rowsContaining(frame, "find the legacy token")
      expect(row).toBeDefined()
      const painted = row as string
      const gutter = resolveSideMargin(80)
      // Left-aligned: the bar sits right at the shared gutter, like an answer.
      expect(painted.indexOf("▍")).toBe(gutter)
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

  test("a second agent brings labels back, once per block and sharing a left edge", async () => {
    await paintRows(
      [
        { role: "user", text: "hi" },
        { role: "assistant", text: "on it" },
        { role: "assistant", text: "reviewing", agent: "critic" },
      ],
      80,
      (frame) => {
        const gutter = resolveSideMargin(80)
        const [corbitsLabel] = rowsContaining(frame, "● agent")
        const [criticLabel] = rowsContaining(frame, "● critic")
        expect(corbitsLabel).toBeDefined()
        expect(criticLabel).toBeDefined()
        // One label per block, and both labels share the transcript's left edge.
        expect((corbitsLabel as string).indexOf("●")).toBe(gutter)
        expect((criticLabel as string).indexOf("●")).toBe(gutter)
        expect(rowsContaining(frame, "on it").some((row) => row.includes("●"))).toBe(false)
        expect(rowsContaining(frame, "reviewing").some((row) => row.includes("●"))).toBe(false)
        // The operator keeps the left gutter regardless.
        const [mine] = rowsContaining(frame, "hi")
        expect((mine as string).indexOf("▍")).toBe(gutter)
      },
    )
  })

  test("a run from the same agent across a tool call keeps one left edge, relabelled per block", async () => {
    await paintRows(
      [
        { role: "user", text: "hi" },
        { role: "assistant", text: "delegating", agent: "corbits" },
        { role: "assistant", text: "on it", agent: "auth-core" },
        { role: "assistant", text: "patching now", agent: "auth-core" },
        { role: "tool", text: "session.ts", meta: "edit", agent: "auth-core" },
      ],
      80,
      (frame) => {
        const gutter = resolveSideMargin(80)
        const labels = inkRows(frame).filter((row) => row.trim() === "● auth-core")
        // The message block and the tool block are two distinct blocks (a
        // role change opens a new one), so the label repeats once per block —
        // never once per row.
        expect(labels.length).toBe(2)
        for (const label of labels) expect(label.indexOf("●")).toBe(gutter)
        expect(rowsContaining(frame, "patching now").some((row) => row.includes("●"))).toBe(
          false,
        )
      },
    )
  })

  test("a long operator turn wraps as one left-aligned block", async () => {
    const text =
      "please find every call site of the legacy token helper and tell me which of them still run in production today"
    for (const columns of [50, 64, 80, 120]) {
      await paintRows([{ role: "user", text }], columns, (frame) => {
        const block = inkRows(frame).filter((row) => row.includes("▍"))
        expect(block.length).toBeGreaterThan(1)
        // One rectangle: every line hangs off the same bar column, at the gutter.
        const gutter = resolveSideMargin(columns)
        const bars = new Set(block.map((row) => row.indexOf("▍")))
        expect(bars.size).toBe(1)
        expect([...bars][0]).toBe(gutter)
        for (const row of block) {
          expect(row.trimEnd().length).toBeLessThanOrEqual(columns - gutter)
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
