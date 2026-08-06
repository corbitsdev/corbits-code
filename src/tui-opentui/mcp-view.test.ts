/**
 * Structured MCP result rows — record lists paint as an aligned table,
 * single records as label/value rows, never as raw JSON.
 */

import { describe, expect, test } from "bun:test"

import {
  extractMcpRecord,
  extractMcpRecords,
} from "../tui/mcp-result-format.js"
import { withTestRenderer, type Harness } from "./harness"
import { mcpStructuredView, toolResultRow } from "./mcp-view"
import { appendStreamRow, createAppShell } from "./shell"
import { isMarkdownRow, isStructuredRow } from "./stream"

const WIDE = { width: 100, height: 24 } as const

const shellOpts = {
  terminal: { columns: 100, rows: 24 },
  wireKeys: false,
} as const

const LIST = JSON.stringify({
  projects: [
    { name: "Alpha", status: "In Progress", priority: "urgent" },
    { name: "Beta", status: { name: "Done" }, priority: "low" },
  ],
  hasNextPage: false,
})

const RECORD = JSON.stringify({
  id: "abc123",
  name: "Alpha",
  status: "In Progress",
  targetDate: "2026-01-31T00:00:00.000Z",
})

async function settle(h: Harness): Promise<string> {
  await h.renderOnce()
  await h.renderOnce()
  return h.captureCharFrame()
}

/** Column start index of `needle` on the first line that contains it. */
function columnOf(frame: string, needle: string): number {
  const line = frame.split("\n").find((l) => l.includes(needle))
  expect(line).toBeDefined()
  return (line as string).indexOf(needle)
}

describe("extractMcpRecords / extractMcpRecord", () => {
  test("pulls a wrapped record array", () => {
    const records = extractMcpRecords(LIST)
    expect(records?.label).toBe("projects")
    expect(records?.items).toHaveLength(2)
  })

  test("distinguishes a single record from a list", () => {
    expect(extractMcpRecords(RECORD)).toBeNull()
    expect(extractMcpRecord(RECORD)).not.toBeNull()
    expect(extractMcpRecord(LIST)).toBeNull()
  })
})

describe("mcpStructuredView", () => {
  test("record list becomes a header plus one row per record", () => {
    const view = mcpStructuredView("mcp__linear__list_projects", LIST)
    expect(view).not.toBeNull()
    const cells = view?.cells ?? []
    expect(cells[0]?.map((c) => c.text)).toEqual([
      "#",
      "Name",
      "Status",
      "Priority",
    ])
    expect(cells[1]?.map((c) => c.text)).toEqual([
      "1",
      "Alpha",
      "In Progress",
      "urgent",
    ])
    expect(cells[2]?.[2]).toEqual({ text: "Done", tone: "success" })
    expect(cells[1]?.[3]?.tone).toBe("danger")
  })

  test("single record becomes label/value rows with dates truncated", () => {
    const view = mcpStructuredView("mcp__linear__get_project", RECORD)
    expect(view?.cells.map((row) => row.map((c) => c.text))).toEqual([
      ["Alpha", ""],
      ["Status", "In Progress"],
      ["Target Date", "2026-01-31"],
    ])
  })

  test("non-MCP tools and non-record payloads stay unstructured", () => {
    expect(mcpStructuredView("bash", LIST)).toBeNull()
    expect(mcpStructuredView("mcp__linear__ping", "just text")).toBeNull()
    expect(
      toolResultRow({ name: "mcp__linear__x", content: LIST, isError: true })
        .structured,
    ).toBeUndefined()
  })

  test("structured rows are not markdown rows", () => {
    const row = toolResultRow({
      name: "mcp__linear__list_projects",
      content: LIST,
    })
    expect(isStructuredRow(row)).toBe(true)
    expect(isMarkdownRow(row)).toBe(false)
  })
})

describe("structured transcript rows", () => {
  test("record list renders aligned columns", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, shellOpts)
      appendStreamRow(
        shell,
        toolResultRow({ name: "mcp__linear__list_projects", content: LIST }),
      )

      const frame = await settle(h)
      expect(frame).toContain("Name")
      expect(frame).toContain("Alpha")
      expect(frame).not.toContain('{"projects"')
      // Same column for both records means native table alignment held.
      expect(columnOf(frame, "Alpha")).toBe(columnOf(frame, "Beta"))
      expect(columnOf(frame, "In Progress")).toBe(columnOf(frame, "Done"))
    }, WIDE)
  })

  test("single record renders label/value rows", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, shellOpts)
      appendStreamRow(
        shell,
        toolResultRow({ name: "mcp__linear__get_project", content: RECORD }),
      )

      const frame = await settle(h)
      expect(frame).toContain("Status")
      expect(frame).toContain("In Progress")
      expect(frame).toContain("Target Date")
      expect(frame).toContain("2026-01-31")
      expect(frame).not.toContain("abc123")
      expect(columnOf(frame, "Status")).toBe(columnOf(frame, "Target Date"))
      expect(columnOf(frame, "In Progress")).toBe(columnOf(frame, "2026-01-31"))
    }, WIDE)
  })
})
