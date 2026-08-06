/**
 * Structured rendering of MCP tool results for the OpenTUI transcript.
 *
 * MCP servers answer with raw JSON — record lists (list_projects) or single
 * records (get_issue). Painted verbatim they are an unreadable dump, so we
 * derive a cell grid: a header + one row per record for lists, label/value
 * pairs for a single record, with status/priority tone and date truncation.
 *
 * The grid is carried on the row and painted by `TextTableRenderable`, whose
 * native column measurement does the alignment. We do not reimplement layout.
 */

import { fg as fgChunk, bold as boldChunk, type TextChunk } from "@opentui/core"

import { isMcpToolName } from "../mcp/tool-name.js"
import {
  extractMcpRecord,
  extractMcpRecords,
  recordScalar,
  type McpRecords,
} from "../tui/mcp-result-format.js"
import type { StreamRow } from "./stream.js"

export type McpTone =
  | "plain"
  | "muted"
  | "accent"
  | "success"
  | "warning"
  | "danger"

export type McpCell = {
  readonly text: string
  readonly tone?: McpTone
  readonly bold?: boolean
}

/** Row-major cell grid; every row is one table row, cells are columns. */
export type McpStructuredView = {
  readonly cells: readonly (readonly McpCell[])[]
}

const TONE_FG: Record<McpTone, string> = {
  plain: "#c0caf5",
  muted: "#565f89",
  accent: "#7aa2f7",
  success: "#9ece6a",
  warning: "#e0af68",
  danger: "#f7768e",
}

const NAME_FIELDS = ["name", "title", "identifier", "label", "key", "summary"]
const STATUS_FIELDS = ["status", "state"]
const PRIORITY_FIELDS = ["priority"]
const TEAM_FIELDS = ["team"]
const TARGET_FIELDS = ["targetDate", "target", "dueDate"]

const DETAIL_ORDER = [
  "status",
  "state",
  "priority",
  "team",
  "lead",
  "assignee",
  "startDate",
  "targetDate",
  "dueDate",
  "url",
  "description",
  "summary",
]
const DETAIL_HIDE = new Set([
  "id",
  "createdAt",
  "updatedAt",
  "archivedAt",
  "completedAt",
  "canceledAt",
  "icon",
  "color",
  "slug",
])
const TITLE_FIELDS = ["name", "title", "identifier", "label", "key"]
const DATE_KEYS = new Set(["startDate", "targetDate", "dueDate"])
const DATE_WIDTH = 10
const MAX_ROWS = 30

function firstScalar(
  record: Record<string, unknown>,
  fields: readonly string[],
): string | undefined {
  for (const field of fields) {
    const value = recordScalar(record, field)
    if (value !== null && value.length > 0) return value
  }
  return undefined
}

function humanizeField(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/^./, (c) => c.toUpperCase())
}

function statusTone(value: string): McpTone {
  const v = value.toLowerCase()
  if (/(done|complete|merged|closed|active)/.test(v)) return "success"
  if (/(progress|started|review)/.test(v)) return "accent"
  if (/(cancel|block|fail|reject)/.test(v)) return "danger"
  return "muted"
}

function priorityTone(value: string): McpTone {
  const v = value.toLowerCase()
  if (v === "urgent") return "danger"
  if (v === "high") return "warning"
  if (v === "medium") return "accent"
  return "muted"
}

type ColumnDef = {
  readonly header: string
  readonly get: (record: Record<string, unknown>, index: number) => string
  readonly tone?: (value: string) => McpTone
}

/** Record list → header row plus one row per record. */
export function mcpRecordsToView(records: McpRecords): McpStructuredView {
  const has = (fields: readonly string[]): boolean =>
    records.items.some((record) => firstScalar(record, fields) !== undefined)

  const columns: ColumnDef[] = [
    { header: "#", get: (_record, index) => String(index + 1) },
    { header: "Name", get: (record) => firstScalar(record, NAME_FIELDS) ?? "" },
  ]
  if (has(STATUS_FIELDS)) {
    columns.push({
      header: "Status",
      get: (record) => firstScalar(record, STATUS_FIELDS) ?? "",
      tone: statusTone,
    })
  }
  if (has(PRIORITY_FIELDS)) {
    columns.push({
      header: "Priority",
      get: (record) => firstScalar(record, PRIORITY_FIELDS) ?? "",
      tone: priorityTone,
    })
  }
  if (has(TEAM_FIELDS)) {
    columns.push({
      header: "Team",
      get: (record) => firstScalar(record, TEAM_FIELDS) ?? "",
    })
  }
  if (has(TARGET_FIELDS)) {
    columns.push({
      header: "Target",
      get: (record) =>
        (firstScalar(record, TARGET_FIELDS) ?? "").slice(0, DATE_WIDTH),
    })
  }

  const header = columns.map(
    (column): McpCell => ({ text: column.header, tone: "muted", bold: true }),
  )
  const shown = records.items.slice(0, MAX_ROWS)
  const rows = shown.map((record, index) =>
    columns.map((column): McpCell => {
      const text = column.get(record, index)
      const tone = column.tone?.(text)
      return tone !== undefined ? { text, tone } : { text }
    }),
  )
  const overflow =
    records.items.length > shown.length
      ? [
          [
            {
              text: `+${records.items.length - shown.length} more`,
              tone: "muted" as const,
            },
          ],
        ]
      : []

  return { cells: [header, ...rows, ...overflow] }
}

/** Single record → title row plus one label/value row per field. */
export function mcpRecordToView(
  record: Record<string, unknown>,
): McpStructuredView {
  const titleKey = TITLE_FIELDS.find(
    (field) => (recordScalar(record, field) ?? "").length > 0,
  )
  const title =
    titleKey !== undefined ? (recordScalar(record, titleKey) ?? "") : ""

  const present = Object.keys(record).filter(
    (key) =>
      key !== titleKey &&
      !DETAIL_HIDE.has(key) &&
      (recordScalar(record, key) ?? "").length > 0,
  )
  const ordered = [
    ...DETAIL_ORDER.filter((key) => present.includes(key)),
    ...present.filter((key) => !DETAIL_ORDER.includes(key)),
  ]

  const cells: McpCell[][] = []
  if (title.length > 0) {
    cells.push([{ text: title, tone: "accent", bold: true }, { text: "" }])
  }
  for (const key of ordered.slice(0, MAX_ROWS)) {
    const raw = recordScalar(record, key) ?? ""
    const value = DATE_KEYS.has(key) ? raw.slice(0, DATE_WIDTH) : raw
    const tone =
      key === "status" || key === "state"
        ? statusTone(value)
        : key === "priority"
          ? priorityTone(value)
          : undefined
    cells.push([
      { text: humanizeField(key), tone: "muted" },
      tone !== undefined ? { text: value, tone } : { text: value },
    ])
  }

  return { cells }
}

/**
 * Structured view for an MCP tool result body, or null when the tool is not an
 * MCP tool or the payload is not record-shaped (plain text, scalars, errors).
 */
export function mcpStructuredView(
  toolName: string,
  content: string,
): McpStructuredView | null {
  if (!isMcpToolName(toolName)) return null
  const records = extractMcpRecords(content)
  if (records !== null) return mcpRecordsToView(records)
  const record = extractMcpRecord(content)
  if (record !== null) {
    const view = mcpRecordToView(record)
    return view.cells.length > 0 ? view : null
  }
  return null
}

export type ToolResultRowInput = {
  readonly name: string
  readonly content: string
  readonly isError?: boolean
}

/**
 * Build the transcript row for a tool result, attaching a structured view when
 * the result is a renderable MCP payload. Errors stay literal text.
 */
export function toolResultRow(input: ToolResultRowInput): StreamRow {
  const meta = input.isError === true ? `${input.name}!` : input.name
  const structured =
    input.isError === true ? null : mcpStructuredView(input.name, input.content)
  return {
    role: "tool",
    text: input.content,
    meta,
    ...(structured !== null ? { structured } : {}),
  }
}

/** Map a cell grid to `TextTableRenderable` content chunks. */
export function viewToTableContent(
  view: McpStructuredView,
): (TextChunk[] | null)[][] {
  return view.cells.map((row) =>
    row.map((cell) => {
      const colored = fgChunk(TONE_FG[cell.tone ?? "plain"])(cell.text)
      return [cell.bold === true ? boldChunk(colored) : colored]
    }),
  )
}
