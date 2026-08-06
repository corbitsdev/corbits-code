import { describe, expect, test } from "bun:test"
import { stringWidth } from "../tui/view/height"
import {
  agentVoicesIn,
  blockLabel,
  isMultiAgent,
  paintStreamRow,
  rowGroupGap,
  streamRowGutter,
  toolFamily,
  type RowLayout,
  type StreamRow,
} from "./stream"
import { UI } from "./theme"

const SOLO: RowLayout = { width: 56, multiAgent: false }
const CREW: RowLayout = { width: 56, multiAgent: true }

const lines = (row: StreamRow, layout: RowLayout = SOLO): string[] =>
  paintStreamRow(row, layout).content.split("\n")

describe("stream paint", () => {
  test("one voice needs no labels: the operator is found by the bar", () => {
    const you = lines({ role: "user", text: "hi" })[0] as string
    const agent = lines({ role: "assistant", text: "hello" })[0] as string

    expect(you).not.toContain("you")
    expect(agent).not.toContain("agent")
    expect(agent.startsWith("hello")).toBe(true)
    expect(you.startsWith("▍")).toBe(true)
    expect(you.trimEnd().endsWith("hi")).toBe(true)
  })

  test("the operator's bubble starts on the transcript's first column", () => {
    for (const width of [40, 56, 100]) {
      const painted = lines(
        { role: "user", text: "find the legacy token before the release" },
        { width, multiAgent: false },
      )
      for (const line of painted) {
        expect(line.indexOf("▍")).toBe(0)
        expect(stringWidth(line)).toBeLessThanOrEqual(width)
      }
    }
  })

  test("a long operator message wraps as one left-aligned block", () => {
    const text =
      "please find every call site of the legacy token helper and tell me which of them still run in production"
    for (const width of [40, 56, 80, 120]) {
      const painted = lines({ role: "user", text }, { width, multiAgent: false })
      expect(painted.length).toBeGreaterThan(1)
      // One rectangle: every line's bar sits on the same column.
      const bars = new Set(painted.map((line) => line.indexOf("▍")))
      expect(bars.size).toBe(1)
      for (const line of painted) expect(stringWidth(line)).toBeLessThanOrEqual(width)
    }
  })

  test("both human voices keep the cream; nothing paints a gray", () => {
    const rows: readonly StreamRow[] = [
      { role: "user", text: "x" },
      { role: "assistant", text: "x" },
      { role: "tool", text: "x", meta: "bash" },
      { role: "system", text: "x" },
    ]
    const [you, agent] = rows.map((row) => paintStreamRow(row, SOLO).fg)
    expect(you).toBe(UI.text)
    expect(agent).toBe(UI.text)
    for (const row of rows) {
      const fg = paintStreamRow(row, SOLO).fg
      const [r, g, b] = [1, 3, 5].map((i) =>
        Number.parseInt(fg.slice(i, i + 2), 16),
      ) as [number, number, number]
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeGreaterThan(8)
    }
  })

  test("tool rows share a result column regardless of tool name", () => {
    const short = lines({ role: "tool", text: "ok", meta: "ls" })[0] as string
    const long = lines({ role: "tool", text: "ok", meta: "read_file" })[0] as string
    expect(short.indexOf("ok")).toBe(long.indexOf("ok"))
  })

  test("each tool family carries its own single-cell glyph", () => {
    const families = [
      "read_file",
      "write_file",
      "grep",
      "bash",
      "web_fetch",
      "task",
      "use_skill",
      "mcp__linear__list_issues",
      "wibble",
    ]
    const glyphs = families.map(
      (name) => (lines({ role: "tool", text: "x", meta: name })[0] as string)[2],
    )
    expect(new Set(glyphs).size).toBe(families.length)
    for (const glyph of glyphs) expect(stringWidth(glyph as string)).toBe(1)
    expect(toolFamily("mcp__linear__list_issues")).toBe("mcp")
    expect(toolFamily("wibble")).toBe("other")
  })

  test("a result continues its call instead of repeating the tool name", () => {
    const call = lines({ role: "tool", text: '"legacy"', meta: "grep" })[0] as string
    const result = lines({
      role: "tool",
      text: "42 matches",
      meta: "grep",
      result: true,
    })[0] as string
    expect(result).not.toContain("grep")
    expect(result).toContain("└")
    expect(result.indexOf("42 matches")).toBe(call.indexOf('"legacy"'))
  })

  test("a failed tool call is marked and steps out of the live tool voice", () => {
    const ok = paintStreamRow({ role: "tool", text: "ok", meta: "bash" }, SOLO)
    const bad = paintStreamRow(
      { role: "tool", text: "boom", meta: "bash", failed: true },
      SOLO,
    )
    expect(bad.content).toContain("×")
    expect(ok.content).not.toContain("×")
    expect(bad.fg).not.toBe(ok.fg)
    // Orange stays reserved for the thing awaiting a decision.
    expect(bad.fg).not.toBe(UI.action)
  })

  test("reasoning is a faint, inset, marked block", () => {
    const painted = paintStreamRow(
      {
        role: "system",
        text: "scanning the repo\nthen the call sites",
        meta: "thinking",
      },
      SOLO,
    )
    expect(painted.fg).toBe(UI.textFaint)
    const rows = painted.content.split("\n")
    expect(rows.length).toBe(2)
    for (const row of rows) {
      expect(row.startsWith("  ┆ ")).toBe(true)
    }
    expect(paintStreamRow({ role: "assistant", text: "done" }, SOLO).fg).toBe(UI.text)
  })

  test("a long reasoning body wraps inside its own block", () => {
    const rows = lines({
      role: "system",
      meta: "thinking",
      text: "the token helper is referenced from four packages and two of them are vendored",
    })
    expect(rows.length).toBeGreaterThan(1)
    for (const row of rows) {
      expect(row.startsWith("  ┆ ")).toBe(true)
      expect(stringWidth(row)).toBeLessThanOrEqual(SOLO.width)
    }
  })

  test("a second agent's row paints no icon or name inline", () => {
    // Writer identity is a block-level header (see `blockLabel`), not baked
    // into the row body, so a lone row never carries "●" itself.
    const solo = lines({ role: "assistant", text: "on it" })[0] as string
    const crew = lines({ role: "assistant", text: "on it", agent: "critic" }, CREW)[0] as string
    expect(solo).not.toContain("●")
    expect(crew).not.toContain("●")
    expect(crew.startsWith("on it")).toBe(true)
    // The operator stays a left-aligned bubble either way.
    expect(lines({ role: "user", text: "go" }, CREW)[0]).toBe(
      lines({ role: "user", text: "go" })[0],
    )
  })

  test("reasoning keeps one marker column across its lines", () => {
    const rows = lines(
      { role: "system", meta: "thinking", text: "checking\nthen deciding", agent: "critic" },
      CREW,
    )
    expect(rows[0]).toContain("┆")
    const markers = new Set(rows.map((row) => row.indexOf("┆")))
    expect(markers.size).toBe(1)
  })

  test("a loaded skill collapses to a summary until it is expanded", () => {
    const row: StreamRow = {
      role: "tool",
      text: 'Skill "style" — follow these instructions\n\nline\nline',
      meta: "use_skill",
      result: true,
      skill: "style",
    }
    const collapsed = lines(row)
    expect(collapsed.length).toBe(1)
    expect(collapsed[0]).toContain('skill "style" loaded')
    expect(collapsed[0]).toContain("4 lines")
    expect(collapsed[0]).toContain("e expand")

    const expanded = lines({ ...row, expanded: true })
    expect(expanded.length).toBe(5)
    expect(expanded[0]).toContain("e collapse")
    expect(expanded.join("\n")).toContain("line")
  })
})

describe("writer identity", () => {
  test("distinct writers are counted from the transcript, not configured", () => {
    const solo: readonly StreamRow[] = [
      { role: "user", text: "go" },
      { role: "assistant", text: "ok" },
      { role: "tool", text: "ls", meta: "bash" },
    ]
    expect(isMultiAgent(solo)).toBe(false)
    expect(agentVoicesIn(solo).size).toBe(1)
    expect(isMultiAgent([...solo, { role: "assistant", text: "hi", agent: "critic" }])).toBe(
      true,
    )
  })
})

describe("vertical rhythm", () => {
  const you = { role: "user", text: "go" } as const
  const agent = { role: "assistant", text: "ok" } as const
  const grep = { role: "tool", text: "x", meta: "grep" } as const
  const grepResult = { role: "tool", text: "42 matches", meta: "grep" } as const
  const bash = { role: "tool", text: "ls", meta: "bash" } as const
  const thinking = {
    role: "system",
    text: "hmm",
    meta: "thinking",
  } as const

  test("the first row opens no gap", () => {
    expect(rowGroupGap(undefined, you)).toBe(0)
  })

  test("a turn boundary opens a gap", () => {
    expect(rowGroupGap(you, agent)).toBe(1)
    expect(rowGroupGap(agent, grep)).toBe(1)
  })

  test("a result stays glued to its call, the next call does not", () => {
    expect(rowGroupGap(grep, grepResult)).toBe(0)
    expect(rowGroupGap(grepResult, bash)).toBe(1)
  })

  test("thinking takes the turn's gap instead of opening one of its own", () => {
    // Same rows either way, so the coalesced line cannot shift the answer.
    expect(rowGroupGap(you, thinking) + rowGroupGap(thinking, agent)).toBe(
      rowGroupGap(you, agent),
    )
    expect(rowGroupGap(agent, thinking)).toBe(0)
  })
})

describe("row gutter", () => {
  test("a lone agent's markdown body starts on the first column", () => {
    expect(streamRowGutter({ role: "assistant", text: "hi" }, SOLO).content).toBe("")
  })

  test("writer identity never lands in the per-row gutter, multi-agent or not", () => {
    expect(streamRowGutter({ role: "assistant", text: "hi", agent: "critic" }, CREW).content)
      .toBe("")
  })
})

describe("block labels", () => {
  const you = { role: "user", text: "go" } as const
  const corbits = { role: "assistant", text: "on it" } as const
  const critic = { role: "assistant", text: "reviewing", agent: "critic" } as const

  test("single-agent transcripts never label a row", () => {
    expect(blockLabel(undefined, corbits, SOLO)).toBeNull()
    expect(blockLabel(you, corbits, SOLO)).toBeNull()
  })

  test("the operator's own turn is never labelled", () => {
    expect(blockLabel(corbits, you, CREW)).toBeNull()
  })

  test("a block's first row is labelled with its writer", () => {
    expect(blockLabel(undefined, corbits, CREW)).toBe("● agent")
    expect(blockLabel(you, critic, CREW)).toBe("● critic")
  })

  test("a run from the same writer labels only its first row", () => {
    const secondFromCorbits = { role: "assistant", text: "still going" } as const
    expect(blockLabel(corbits, secondFromCorbits, CREW)).toBeNull()
  })

  test("a change of writer relabels even without a role change", () => {
    expect(blockLabel(corbits, critic, CREW)).toBe("● critic")
  })
})
