import { describe, expect, test } from "bun:test"

import {
  diffLines,
  diffPlainText,
  diffStat,
  editDiffFromArgs,
  editDiffView,
  renderDiff,
  toolCallRow,
  type DiffLine,
} from "./diff.js"
import { DIFF_FG, isDiffRow, isMarkdownRow } from "./stream.js"

const textOf = (line: DiffLine): string =>
  line.map((seg) => seg.text).join("")

describe("diffLines", () => {
  test("marks added, removed, and context lines", () => {
    expect(diffLines("a\nb\nc", "a\nB\nc")).toEqual([
      { kind: "context", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "B" },
      { kind: "context", text: "c" },
    ])
  })

  test("treats an empty old side as a pure addition", () => {
    expect(diffLines("", "x\ny")).toEqual([
      { kind: "add", text: "x" },
      { kind: "add", text: "y" },
    ])
  })
})

describe("diffStat", () => {
  test("counts additions and removals", () => {
    expect(diffStat("a\nb", "a\nc\nd")).toEqual({ added: 2, removed: 1 })
  })
})

describe("editDiffFromArgs", () => {
  test("reads edit_file before/after from old_string and new_string", () => {
    expect(
      editDiffFromArgs(
        "edit_file",
        JSON.stringify({ path: "x.ts", old_string: "foo", new_string: "bar" }),
      ),
    ).toEqual({ oldText: "foo", newText: "bar", path: "x.ts" })
  })

  test("treats write_file content as the new side against an empty old side", () => {
    expect(
      editDiffFromArgs(
        "write_file",
        JSON.stringify({ path: "x.ts", content: "line" }),
      ),
    ).toEqual({ oldText: "", newText: "line", path: "x.ts" })
  })

  test("returns null for unrelated tools and bad JSON", () => {
    expect(editDiffFromArgs("read_file", "{}")).toBeNull()
    expect(editDiffFromArgs("edit_file", "not json")).toBeNull()
  })
})

describe("renderDiff", () => {
  test("prefixes changed lines with + and - gutters", () => {
    const text = renderDiff("old", "new", 40).map(textOf).join("\n")
    expect(text).toContain("- old")
    expect(text).toContain("+ new")
  })

  test("collapses unchanged runs when contextLines is set", () => {
    const oldText = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n")
    const newText = oldText.replace("line 0", "CHANGED")
    const text = renderDiff(oldText, newText, 40, { contextLines: 2 })
      .map(textOf)
      .join("\n")
    expect(text).toContain("unchanged line")
  })

  test("word-level LCS keeps shared tokens as context and paints only the delta", () => {
    const lines = renderDiff(
      "const foo = bar(x, y);",
      "const foo = baz(x, y);",
      80,
    )
    const delBody = lines[0]!.slice(2)
    const addBody = lines[1]!.slice(2)
    const delChanged = delBody
      .filter((s) => s.fg === DIFF_FG.del)
      .map((s) => s.text)
      .join("")
    const addChanged = addBody
      .filter((s) => s.fg === DIFF_FG.add)
      .map((s) => s.text)
      .join("")
    expect(delChanged).toContain("bar")
    expect(addChanged).toContain("baz")
    expect(delChanged).not.toContain("const")
    expect(addChanged).not.toContain("const")
    expect(
      delBody.some((s) => s.text.includes("const") && s.fg === DIFF_FG.context),
    ).toBe(true)
  })

  test("changed intra-line tokens are bold; shared tokens are not", () => {
    const lines = renderDiff("a b c", "a x c", 40)
    const delBody = lines[0]!.slice(2)
    expect(delBody.find((s) => s.text === "b")?.bold).toBe(true)
    expect(delBody.find((s) => s.text === "a")?.bold).toBeUndefined()
  })

  test("word-level LCS is not positional — reordered shared words stay context", () => {
    const lines = renderDiff("a b c", "a x c", 40)
    const changed = lines[0]!
      .slice(2)
      .filter((s) => s.fg === DIFF_FG.del)
      .map((s) => s.text.trim())
      .filter(Boolean)
    expect(changed).toEqual(["b"])
  })

  test("unpaired adds and removals take the add/remove tone whole-line", () => {
    const [removed] = renderDiff("old line", "", 40)
    const [added] = renderDiff("", "new line", 40)
    expect(removed!.slice(1).every((s) => s.fg === DIFF_FG.del)).toBe(true)
    expect(added!.slice(1).every((s) => s.fg === DIFF_FG.add)).toBe(true)
  })

  test("context rows take the muted context tone", () => {
    const lines = renderDiff("a\nb", "a\nB", 40)
    expect(lines[0]!.every((s) => s.fg === DIFF_FG.context)).toBe(true)
  })

  test("line-number column always uses the muted context tone", () => {
    const lines = renderDiff("a\nb", "a\nB", 40)
    expect(lines.map((line) => line[0]!.fg)).toEqual([
      DIFF_FG.context,
      DIFF_FG.context,
      DIFF_FG.context,
    ])
  })

  test("wraps long bodies while keeping the gutter column aligned", () => {
    const long = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ")
    const lines = renderDiff("", long, 30, { lineNumbers: false })
    expect(lines.length).toBeGreaterThan(1)
    expect(lines[0]![0]!.text).toBe("+ ")
    // Continuation rows blank the sign column rather than repeating it.
    expect(lines[1]![0]!.text).toBe("  ")
  })
})

describe("renderDiff line numbers", () => {
  test("context rows carry both old and new line numbers", () => {
    const lines = renderDiff("a\nb\nc", "a\nB\nc", 40)
    expect(textOf(lines[0]!)).toContain("1 1")
    expect(textOf(lines[1]!)).toContain("2  ")
    expect(textOf(lines[2]!)).toContain(" 2")
    expect(textOf(lines[3]!)).toContain("3 3")
  })

  test("del rows show only the old number, add rows show only the new number", () => {
    const lines = renderDiff("old", "new", 40)
    expect(lines[0]![0]!.text).toBe("1   ")
    expect(lines[1]![0]!.text).toBe("  1 ")
  })

  test("lineNumbers: false omits the number gutter entirely", () => {
    const lines = renderDiff("old", "new", 40, { lineNumbers: false })
    expect(lines.map(textOf)).toEqual(["- old", "+ new"])
  })

  test("line numbers stay right-aligned as the file grows past one digit", () => {
    const oldText = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n")
    const newText = oldText.replace("line 0", "CHANGED")
    const widths = new Set(
      renderDiff(oldText, newText, 80).map((line) => line[0]!.text.length),
    )
    expect(widths.size).toBe(1)
  })

  test("collapsed context marker carries no line number", () => {
    const oldText = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n")
    const newText = oldText.replace("line 0", "CHANGED")
    const lines = renderDiff(oldText, newText, 40, { contextLines: 2 })
    const marker = lines.find((line) => textOf(line).includes("unchanged line"))
    expect(marker).toBeDefined()
    expect(marker![0]!.text.trim()).toBe("")
  })
})

describe("editDiffView", () => {
  const EDIT_ARGS = JSON.stringify({
    path: "src/x.ts",
    old_string: "const a = 1",
    new_string: "const a = 2",
  })

  test("builds a numberless diff with stats and path for edit_file", () => {
    const view = editDiffView("edit_file", EDIT_ARGS)
    expect(view).not.toBeNull()
    expect(view!.added).toBe(1)
    expect(view!.removed).toBe(1)
    expect(view!.path).toBe("src/x.ts")
    // Snippet-relative numbers would be misleading, so they are suppressed.
    expect(view!.lines.map(textOf)).toEqual(["- const a = 1", "+ const a = 2"])
  })

  test("returns null for non-edit tools and no-op edits", () => {
    expect(editDiffView("read_file", "{}")).toBeNull()
    expect(
      editDiffView(
        "edit_file",
        JSON.stringify({ old_string: "same", new_string: "same" }),
      ),
    ).toBeNull()
  })

  test("caps a huge write_file body with a truncation marker", () => {
    const content = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n")
    const view = editDiffView("write_file", JSON.stringify({ content }))
    expect(view!.added).toBe(200)
    expect(view!.lines.length).toBeLessThan(200)
    expect(textOf(view!.lines.at(-1)!)).toContain("more diff lines")
  })
})

describe("toolCallRow", () => {
  test("attaches a diff and a +/- summary for an edit call", () => {
    const row = toolCallRow({
      name: "edit_file",
      arguments: JSON.stringify({
        path: "src/x.ts",
        old_string: "a",
        new_string: "b",
      }),
    })
    expect(isDiffRow(row)).toBe(true)
    expect(isMarkdownRow(row)).toBe(false)
    expect(row.meta).toBe("edit_file src/x.ts +1/-1")
  })

  test("leaves non-edit calls as literal argument text", () => {
    const row = toolCallRow({ name: "read_file", arguments: '{"path":"x"}' })
    expect(isDiffRow(row)).toBe(false)
    expect(row.text).toBe('{"path":"x"}')
    expect(row.meta).toBe("read_file")
  })

  test("falls back to a placeholder when arguments are absent", () => {
    expect(toolCallRow({ name: "shell" }).text).toBe("…")
  })

  test("partial streamed arguments do not throw", () => {
    const row = toolCallRow({ name: "edit_file", arguments: '{"path":"x' })
    expect(isDiffRow(row)).toBe(false)
  })
})

describe("diffPlainText", () => {
  test("joins segment text back into a copyable body", () => {
    const view = editDiffView(
      "edit_file",
      JSON.stringify({ old_string: "a", new_string: "b" }),
    )
    expect(diffPlainText(view!)).toBe("- a\n+ b")
  })
})
