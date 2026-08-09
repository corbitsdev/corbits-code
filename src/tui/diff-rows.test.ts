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
import { toolResultRow } from "./mcp-view"

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
        { ...toolCallRow({ name: "edit_file", arguments: EDIT_ARGS }), expanded: true },
      )

      await settle(h)
      const frame = h.captureCharFrame()
      expect(frame).toContain("- const total = sum(a, b)")
      expect(frame).toContain("+ const total = product(a, b)")
      expect(frame).not.toContain("old_string")
      // Summary rides the row's sentence head.
      expect(frame).toContain("src/x.ts")
      expect(frame).toContain("+1/-1")
    }, WIDE)
  })

  test("added and removed lines take the diff palette tones", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, shellOpts)
      appendStreamRow(
        shell,
        { ...toolCallRow({ name: "edit_file", arguments: EDIT_ARGS }), expanded: true },
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
        { ...toolCallRow({ name: "edit_file", arguments: EDIT_ARGS }), expanded: true },
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
    }, WIDE)
  })

  test("a write_file call paints the whole body as additions", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, shellOpts)
      appendStreamRow(
        shell,
        {
          ...toolCallRow({
            name: "write_file",
            arguments: JSON.stringify({
              path: "new.ts",
              content: "export const a = 1\nexport const b = 2",
            }),
          }),
          expanded: true,
        },
      )

      await settle(h)
      const frame = h.captureCharFrame()
      expect(frame).toContain("+ export const a = 1")
      expect(frame).toContain("+ export const b = 2")
      expect(frame).toContain("new.ts")
      expect(frame).toContain("+2/-0")
    }, WIDE)
  })

  test("a sentence-style call and its plain result paint as two legible rows, not one merged row", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, shellOpts)
      appendStreamRow(
        shell,
        toolCallRow({ name: "read_file", arguments: JSON.stringify({ path: "package.json" }) }),
      )
      appendStreamRow(shell, toolResultRow({ name: "read_file", content: "30 lines" }))

      await settle(h)
      const rows = h
        .captureCharFrame()
        .split("\n")
        .filter((line) => line.trim().length > 0)
      const callRow = rows.find((line) => line.includes("Read") && line.includes("package.json"))
      const resultRow = rows.find((line) => line.includes("30 lines"))
      expect(callRow).toBeDefined()
      expect(resultRow).toBeDefined()
      // Two distinct rows, not one row carrying both — a merged row would
      // mean interleaved characters and neither string would appear intact.
      expect(callRow).not.toBe(resultRow)
      expect(callRow).toContain("package.json")
      expect(resultRow).toContain("30 lines")
    }, WIDE)
  })

  test("an edit_file call with an empty old_string (pure creation) still paints", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, shellOpts)
      const before = shell.streamLog.length
      appendStreamRow(shell, {
        ...toolCallRow({
          name: "edit_file",
          arguments: JSON.stringify({
            path: "tmp/scratch.txt",
            old_string: "",
            new_string: "write path ok",
          }),
        }),
        expanded: true,
      })

      await settle(h)
      const frame = h.captureCharFrame()
      expect(frame).toContain("scratch.txt")
      expect(frame).toContain("+ write path ok")
      expect(shell.streamLog.length).toBeGreaterThan(before)
    }, WIDE)
  })
})
