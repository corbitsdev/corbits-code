/**
 * Transcript diff rendering — edit-tool rows must paint a coloured +/- diff,
 * not the tool's raw JSON arguments.
 */

import { describe, expect, test } from "bun:test"
import { rgbToHex, type CapturedSpan } from "@opentui/core"

import { toolCallRow } from "./diff"
import { withTestRenderer, type Harness } from "./harness"
import { appendStreamRow, createAppShell } from "./shell"
import { DIFF_FG } from "./stream"

const WIDE = { width: 100, height: 30 } as const

const shellOpts = {
  terminal: { columns: 100, rows: 30 },
  wireKeys: false,
} as const

const EDIT_ARGS = JSON.stringify({
  path: "src/x.ts",
  old_string: "const total = sum(a, b)",
  new_string: "const total = product(a, b)",
})

async function settle(h: Harness): Promise<void> {
  await h.renderOnce()
  await h.renderOnce()
}

/** Every painted span in the frame, flattened, with fg as a hex string. */
function spansWithHex(
  h: Harness,
): Array<{ text: string; fg: string; attributes: number }> {
  const frame = h.captureSpans()
  return frame.lines.flatMap((line: { spans: CapturedSpan[] }) =>
    line.spans.map((span) => ({
      text: span.text,
      fg: rgbToHex(span.fg).toLowerCase().slice(0, 7),
      attributes: span.attributes,
    })),
  )
}

describe("diff transcript rows", () => {
  test("an edit_file call paints a +/- diff instead of raw JSON args", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, shellOpts)
      appendStreamRow(
        shell,
        toolCallRow({ name: "edit_file", arguments: EDIT_ARGS }),
      )

      await settle(h)
      const frame = h.captureCharFrame()
      expect(frame).toContain("- const total = sum(a, b)")
      expect(frame).toContain("+ const total = product(a, b)")
      expect(frame).not.toContain("old_string")
      // Summary rides the row gutter.
      expect(frame).toContain("src/x.ts +1/-1")
    }, WIDE)
  })

  test("added and removed lines take the diff palette tones", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, shellOpts)
      appendStreamRow(
        shell,
        toolCallRow({ name: "edit_file", arguments: EDIT_ARGS }),
      )

      await settle(h)
      const spans = spansWithHex(h)
      const del = spans.find((s) => s.text.includes("-") && s.text.length <= 2)
      const add = spans.find((s) => s.text.includes("+") && s.text.length <= 2)
      expect(del?.fg).toBe(DIFF_FG.del)
      expect(add?.fg).toBe(DIFF_FG.add)
    }, WIDE)
  })

  test("word-level highlighting keeps shared tokens muted and bolds the delta", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, shellOpts)
      appendStreamRow(
        shell,
        toolCallRow({ name: "edit_file", arguments: EDIT_ARGS }),
      )

      await settle(h)
      const spans = spansWithHex(h)
      const changedRemoved = spans.find((s) => s.text.includes("sum(a,"))
      const changedAdded = spans.find((s) => s.text.includes("product(a,"))
      const shared = spans.filter((s) => s.text.includes("const"))

      expect(changedRemoved?.fg).toBe(DIFF_FG.del)
      expect(changedAdded?.fg).toBe(DIFF_FG.add)
      // Bold attribute distinguishes the changed tokens inside the line.
      expect(changedRemoved!.attributes).toBeGreaterThan(0)
      // "const" is shared by both sides, so it stays in the context tone.
      expect(shared.length).toBeGreaterThan(0)
      expect(shared.every((s) => s.fg === DIFF_FG.context)).toBe(true)
    }, WIDE)
  })

  test("a non-edit tool call paints its summary, not its argument JSON", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, shellOpts)
      appendStreamRow(
        shell,
        toolCallRow({ name: "read_file", arguments: '{"path":"src/x.ts"}' }),
      )

      await settle(h)
      const frame = h.captureCharFrame()
      expect(frame).toContain("src/x.ts")
      expect(frame).not.toContain('{"path"')
      expect(frame).toContain("e expand")
    }, WIDE)
  })

  test("a write_file call paints the whole body as additions", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, shellOpts)
      appendStreamRow(
        shell,
        toolCallRow({
          name: "write_file",
          arguments: JSON.stringify({
            path: "new.ts",
            content: "export const a = 1\nexport const b = 2",
          }),
        }),
      )

      await settle(h)
      const frame = h.captureCharFrame()
      expect(frame).toContain("+ export const a = 1")
      expect(frame).toContain("+ export const b = 2")
      expect(frame).toContain("new.ts +2/-0")
    }, WIDE)
  })
})
