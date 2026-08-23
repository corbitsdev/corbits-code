/**
 * Collapse-by-default contract: what a tool call and a chain of thought look
 * like before the expand key is pressed, and that neither ever escapes the
 * shared gutter on its way there.
 */
import { describe, expect, test } from "bun:test"
import { toolCallRow } from "./diff"
import { resolveSideMargin } from "./geometry/margins"
import { withTestRenderer } from "./harness"
import {
  appendStreamRow,
  createAppShell,
  toggleCollapsedRow,
  shellFocusTranscript,
  type AppShell,
} from "./shell"
import {
  EXPAND_HINT_LABEL,
  isCollapsibleRow,
  paintStreamRow,
  type RowLayout,
  type StreamRow,
} from "./stream"
import { thinkingLivePreviewLines, thinkingSettledLine, LIVE_THINKING_MAX_LINES } from "./thinking"
import { describeView, toolArgsView } from "./tool-args"

const WIDE: RowLayout = { width: 96, multiAgent: false }

const lines = (row: StreamRow, layout: RowLayout = WIDE): string[] =>
  paintStreamRow(row, layout).content.split("\n")

const VIEW_ARGS = JSON.stringify({
  view: {
    type: "stack",
    children: [
      { type: "text", text: "yoooo", bold: true },
      { type: "text", text: "what's up?", tone: "muted" },
    ],
  },
})

function inkRows(frame: string): readonly string[] {
  return frame.split("\n").filter((row) => row.trim().length > 0)
}

async function paint(
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
        // Bodies the renderer owns settle a frame after they are added.
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

describe("tool bodies stay inside the gutter", () => {
  test("a wrapped tool body never starts at column 0", async () => {
    // A body with no summary of its own (a long result) is the case that used
    // to hard-wrap to column 0, outside both the gutter and the meta column.
    const row: StreamRow = {
      role: "tool",
      meta: "bash",
      text: "the command printed a very long single line of output that has to wrap several times before it runs out of words to say",
    }
    await paint([row], 80, (frame) => {
      const gutter = resolveSideMargin(80)
      const painted = inkRows(frame).filter((line) => line.includes("wrap"))
      expect(painted.length).toBeGreaterThan(0)
      for (const line of painted) {
        expect(line.slice(0, gutter).trim()).toBe("")
      }
    })
  })

  test("every wrapped line lands on the call's body column", () => {
    const row: StreamRow = {
      role: "tool",
      meta: "bash",
      text: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen",
    }
    const painted = lines(row, { width: 40, multiAgent: false })
    expect(painted.length).toBeGreaterThan(1)
    const body = (painted[0] as string).indexOf("one")
    for (const line of painted.slice(1)) {
      expect(line.startsWith(" ".repeat(body))).toBe(true)
      expect(line.trimStart().length).toBeGreaterThan(0)
      expect(line.length).toBeLessThanOrEqual(40)
    }
  })
})

describe("tool arguments collapse to a human summary", () => {
  test("a view tree reads as its shape, never as its JSON", () => {
    const row = toolCallRow({ name: "present", arguments: VIEW_ARGS })
    expect(row.summary).toBe("stack · 2 text nodes")
    const collapsed = lines(row)
    expect(collapsed.length).toBe(1)
    expect(collapsed[0]).toContain("stack · 2 text nodes")
    expect(collapsed[0]).toContain(`${EXPAND_HINT_LABEL} expand`)
    expect(collapsed[0]).not.toContain("{")
  })

  test("expanding renders the view, not pretty-printed JSON", () => {
    const row = toolCallRow({ name: "present", arguments: VIEW_ARGS })
    const expanded = lines({ ...row, expanded: true }).join("\n")
    expect(expanded).toContain(`${EXPAND_HINT_LABEL} collapse`)
    expect(expanded).toContain("yoooo")
    expect(expanded).toContain("what's up?")
    expect(expanded).not.toContain('"type"')
  })

  test("a shell call keeps its command, with newlines intact when opened", () => {
    const row = toolCallRow({
      name: "run_shell",
      arguments: JSON.stringify({ command: "bun test\nbun run build", cwd: "/repo" }),
    })
    expect(row.summary).toContain("bun test")
    const expanded = lines({ ...row, expanded: true }).join("\n")
    expect(expanded).toContain("bun run build")
    expect(expanded).toContain("cwd: ")
  })

  test("short literal arguments are left alone rather than summarised", () => {
    expect(toolArgsView("grep", "token")).toBeNull()
  })

  test("a view tree is described by what it is made of", () => {
    expect(
      describeView({
        type: "stack",
        children: [{ type: "divider" }, { type: "text", text: "a" }],
      }),
    ).toBe("stack · 1 divider node · 1 text node")
  })

  test("the collapsed call paints its summary and hides the JSON", async () => {
    await paint([toolCallRow({ name: "present", arguments: VIEW_ARGS })], 80, (frame) => {
      expect(frame).toContain("stack · 2 text nodes")
      expect(frame).not.toContain('"children"')
    })
  })

  test("the expand key opens the newest summarised call", async () => {
    await paint([toolCallRow({ name: "present", arguments: VIEW_ARGS })], 80, (_frame, shell) => {
      shellFocusTranscript(shell)
      expect(toggleCollapsedRow(shell)).toBe(true)
      expect(shell.streamLog[0]?.expanded).toBe(true)
    })
  })
})

describe("reasoning collapses to a short wrapped preview", () => {
  const text =
    "the token helper is referenced from four packages and two of them are vendored, so the rename has to land in one commit"

  test("while thinking it wraps a short preview instead of sideways-scrolling", () => {
    const painted = lines({ role: "system", meta: "thinking", text, streaming: true })
    expect(painted.length).toBeGreaterThanOrEqual(1)
    expect(painted.length).toBeLessThanOrEqual(LIVE_THINKING_MAX_LINES)
    // Inset and dim is the whole of reasoning's chrome; it carries no rail.
    expect(painted.every((line) => !line.includes("┆"))).toBe(true)
    expect(painted.join("\n")).toContain("one commit")
    for (const line of painted) {
      expect(line.length).toBeLessThanOrEqual(WIDE.width)
    }
  })

  test("the live preview wraps newest text rather than windowing one row", () => {
    expect(thinkingLivePreviewLines("abc def", 20)).toEqual(["abc def"])
    expect(thinkingLivePreviewLines("abcdefghij", 4)).toEqual([
      "abcd",
      "efgh",
      "ij",
    ])
    expect(thinkingLivePreviewLines("line one\nline two", 40)).toEqual([
      "line one line two",
    ])
  })

  test("once done it keeps its own text rather than swapping in a phrase", () => {
    const row: StreamRow = {
      role: "system",
      meta: "thinking",
      text,
      thought: { ms: 12_000 },
    }
    const collapsed = lines(row)
    expect(collapsed.length).toBe(1)
    // The line the operator was reading stays put; nothing is substituted.
    expect(collapsed[0]).toContain("the token helper is referenced")
    expect(collapsed[0]).toContain(`${EXPAND_HINT_LABEL} expand`)
    expect(isCollapsibleRow(row)).toBe(true)

    const expanded = lines({ ...row, expanded: true })
    expect(expanded.length).toBeGreaterThan(1)
    expect(expanded[0]).toContain(`${EXPAND_HINT_LABEL} collapse`)
    expect(expanded.join("\n")).toContain("one commit")
    // Railed body, then the tick that closes the panel and carries the time.
    for (const line of expanded.slice(1, -1)) expect(line).toContain("┆")
    expect(expanded[expanded.length - 1]?.trim()).toBe("╵ 12s")
  })

  test("a long settled chain of thought is cut, never wrapped onto a second row", () => {
    expect(thinkingSettledLine("abc def", 20)).toBe("abc def")
    expect(thinkingSettledLine("abcdefghij", 6)).toBe("abcde…")
    expect(thinkingSettledLine("line one\nline two", 40)).toBe("line one line two")
  })

  test("a hydrated reasoning row with no elapsed time keeps its block", () => {
    const painted = lines({ role: "system", meta: "thinking", text: "a\nb" })
    expect(painted.length).toBe(2)
    expect(painted.every((line) => !line.includes("┆"))).toBe(true)
    expect(painted.map((line) => line.trim())).toEqual(["a", "b"])
  })
})
