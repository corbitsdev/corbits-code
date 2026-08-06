/**
 * One row per tool use: a call and its answer share a row, and a repeated call
 * collapses onto the row it repeats.
 */
import { describe, expect, test } from "bun:test"

import { toolCallRow } from "./diff"
import { withTestRenderer } from "./harness"
import { attachSessionBridge, createRecordingPort } from "./runtime-bridge"
import { createAppShell } from "./shell"
import {
  paintStreamRow,
  toolSentenceLines,
  type RowLayout,
  type StreamRow,
} from "./stream"
import { pushToolCall, pushToolResult } from "./tool-rows"

const LAYOUT: RowLayout = { width: 72, multiAgent: false }

const painted = (row: StreamRow): string => paintStreamRow(row, LAYOUT).content

const LINEAR_ISSUES = JSON.stringify({
  issues: [
    { id: "1", title: "First" },
    { id: "2", title: "Second" },
  ],
})

describe("a call and its answer", () => {
  test("are one row, the answer supplying the subject", () => {
    const rows: StreamRow[] = []
    pushToolCall(rows, {
      name: "mcp__linear__list_issues",
      arguments: JSON.stringify({ team: "core" }),
    })
    expect(rows.length).toBe(1)
    expect(rows[0]?.pending).toBe(true)

    pushToolResult(rows, {
      name: "mcp__linear__list_issues",
      content: LINEAR_ISSUES,
    })
    expect(rows.length).toBe(1)
    expect(rows[0]?.pending).toBeUndefined()
    // The subject stays the call; the answer adds only a certain count.
    expect(rows[0]?.verb).toBe("Linear: List Issues")
    expect(rows[0]?.stat).toBe("2 results")
    expect(painted(rows[0]!)).not.toContain("└")
  })

  test("keep the call as the subject, never the payload", () => {
    const rows: StreamRow[] = []
    pushToolCall(rows, {
      name: "fetch",
      arguments: JSON.stringify({ url: "https://www.apple.com" }),
    })
    pushToolResult(rows, {
      name: "fetch",
      content: "# Apple\n[Apple](/) - [Store](/us/shop/goto/store)\nmore page\nand more",
    })
    expect(rows.length).toBe(1)
    expect(rows[0]?.summary).toContain("https://www.apple.com")
    expect(rows[0]?.summary).not.toContain("Apple](")
    expect(rows[0]?.stat).toBe("4 lines")
    // The page itself is one keypress away rather than on the summary line.
    expect(rows[0]?.detail).toBeDefined()
  })

  test("take a short factual answer as an addendum", () => {
    const rows: StreamRow[] = []
    pushToolCall(rows, { name: "grep", arguments: JSON.stringify({ pattern: "legacy_token" }) })
    pushToolResult(rows, { name: "grep", content: "no matches" })
    expect(rows[0]?.stat).toBe("no matches")
    expect(rows[0]?.detail).toBeUndefined()
  })

  test("mark the row failed, keeping the failure out of the collapsed line", () => {
    const rows: StreamRow[] = []
    pushToolCall(rows, { name: "fetch", arguments: JSON.stringify({ url: "https://x.dev" }) })
    pushToolResult(rows, { name: "fetch", content: "connection refused", isError: true })
    expect(rows.length).toBe(1)
    expect(rows[0]?.failed).toBe(true)
    expect(painted(rows[0]!)).toContain("×")
    expect(rows[0]?.detail?.length).toBeGreaterThan(0)
  })

  test("an answer with no call on the log still gets a row", () => {
    const rows: StreamRow[] = []
    pushToolResult(rows, { name: "shell", content: "orphan" })
    expect(rows.length).toBe(1)
    expect(rows[0]?.text).toBe("orphan")
  })
})

describe("a run of identical calls", () => {
  test("is one row, with every answer behind its arrow", () => {
    const rows: StreamRow[] = []
    for (let i = 0; i < 8; i++) {
      pushToolCall(rows, {
        name: "mcp__linear__list_issues",
        arguments: JSON.stringify({ team: "core" }),
      })
      pushToolResult(rows, {
        name: "mcp__linear__list_issues",
        content: LINEAR_ISSUES,
      })
    }
    expect(rows.length).toBe(1)
    expect(rows[0]?.coalesced).toBe(true)
    expect(rows[0]?.detail?.length).toBe(8)
    // The row says what the call was, never a total it cannot substantiate.
    expect(rows[0]?.verb).toBe("Linear: List Issues")
    expect(rows[0]?.stat).toBeUndefined()
  })

  test("does not swallow a different call by the same tool", () => {
    const rows: StreamRow[] = []
    pushToolCall(rows, { name: "read_file", arguments: JSON.stringify({ path: "a.ts" }) })
    pushToolResult(rows, { name: "read_file", content: "a" })
    pushToolCall(rows, { name: "read_file", arguments: JSON.stringify({ path: "b.ts" }) })
    pushToolResult(rows, { name: "read_file", content: "b" })
    expect(rows.length).toBe(2)
  })
})

describe("a long subject", () => {
  test("is cut to one line rather than wrapped", () => {
    const row = toolCallRow({
      name: "web_search",
      arguments: JSON.stringify({
        query:
          "current overview of Apple Inc and what apple.com represents as the company storefront today",
      }),
    })
    const lines = toolSentenceLines(row, 40)
    expect(lines.length).toBe(1)
    const text = lines[0]!.map((segment) => segment.text).join("")
    expect(text.length).toBeLessThanOrEqual(40)
    expect(text).toContain("…")
  })
})

describe("a live turn", () => {
  test("resolves the call row in place instead of appending an answer", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "idle",
        })
        const bridge = attachSessionBridge(shell, createRecordingPort())
        try {
          bridge.play([
            {
              type: "inference.tool_call.end",
              data: {
                name: "mcp__linear__list_issues",
                callId: "c1",
                arguments: { team: "core" },
              },
            },
          ])
          expect(shell.streamLog.length).toBe(1)
          expect(shell.streamLog[0]?.pending).toBe(true)

          bridge.play([
            {
              type: "tool.done",
              data: { result: { callId: "c1", content: LINEAR_ISSUES } },
            },
          ])
          expect(shell.streamLog.length).toBe(1)
          expect(shell.streamLog[0]?.stat).toBe("2 results")

          await h.renderOnce()
          const frame = h.captureCharFrame()
          expect(frame).toContain("Linear: List Issues 2 results")
          expect(frame).not.toContain("└")
        } finally {
          bridge.dispose()
          shell.dispose()
        }
      },
      { width: 80, height: 24 },
    )
  })
})
