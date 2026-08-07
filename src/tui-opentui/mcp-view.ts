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
 *
 * This module also owns what a tool result *says* when collapsed — one sentence
 * derived from the shape of the payload ("Grabbed 10 Linear issues") rather
 * than from the arguments that asked for it, since nobody reads a transcript
 * for the pagination cursor.
 */

import { fg as fgChunk, bold as boldChunk, type TextChunk } from "@opentui/core"

import { sliceToWidth, stringWidth } from "../tui/view/height.js"
import { humanizeMcpTool, isMcpToolName, mcpToolWords, parseMcpToolName } from "../mcp/tool-name.js"
import { UI } from "./theme.js"
import {
  extractMcpRecord,
  extractMcpRecords,
  recordScalar,
  type McpRecords,
} from "../tui/mcp-result-format.js"
import { stripTaskReportEnvelope, summarizeToolResult } from "../tui/tool-formatter.js"
import type { StreamRow, StyledBodyLine } from "./stream.js"

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

// Warning and danger both land on the action orange: a structured result has no
// decision marker competing with it, and there is no red in the brand system.
const TONE_FG: Record<McpTone, string> = {
  plain: UI.text,
  muted: UI.textDim,
  accent: UI.inFlightBright,
  success: UI.done,
  warning: UI.actionDim,
  danger: UI.action,
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
  /** Runtime call id this result answers, when the source carried one. */
  readonly callId?: string
}

/** Bodies at or under this many lines read faster than a sentence about them. */
const COLLAPSE_MIN_LINES = 4

/** A collapsed body is still a transcript row, not a pager. */
const MAX_DETAIL_LINES = 60

/** Longest a listed name/description may run before it is cut. */
const DETAIL_TEXT_MAX = 72

/** The tool a capability search arrives through; its result is a catalogue. */
const TOOL_SEARCH_TOOL = "tool_search"

/** The tool a sub-agent dispatch arrives through; its result is a report. */
const TASK_TOOL = "task"

function titleCase(word: string): string {
  return word.length === 0 ? word : `${word[0]!.toUpperCase()}${word.slice(1)}`
}

function singular(noun: string): string {
  return noun.endsWith("s") ? noun.slice(0, -1) : noun
}

function plural(noun: string): string {
  return noun.endsWith("s") ? noun : `${noun}s`
}

function countNoun(count: number, noun: string): string {
  return `${count} ${count === 1 ? singular(noun) : plural(noun)}`
}

const MCP_TOOL_VERB_PREFIXES = [
  "list_",
  "get_",
  "search_",
  "find_",
  "read_",
  "fetch_",
  "query_",
  "save_",
  "create_",
  "update_",
  "delete_",
]

/**
 * The thing an MCP tool is about, read off its name: `list_issues` -> "issues",
 * `get_project` -> "project". Only used to name a count the payload could not
 * name itself, so a tool whose name carries no noun yields nothing.
 */
function nounFromToolName(server: string, tool: string): string | undefined {
  const prefix = MCP_TOOL_VERB_PREFIXES.find((candidate) =>
    tool.startsWith(candidate),
  )
  const stripped = prefix === undefined ? tool : tool.slice(prefix.length)
  const rest = mcpToolWords(server, stripped).join(" ")
  return rest.length > 0 ? rest : undefined
}

function cut(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim()
  return stringWidth(oneLine) <= DETAIL_TEXT_MAX
    ? oneLine
    : `${sliceToWidth(oneLine, DETAIL_TEXT_MAX - 1)}…`
}

function plainLine(text: string, fg: string = UI.text): StyledBodyLine {
  return [{ text, fg }]
}

/** Bounded literal rendering of a tool payload, for a row's expanded body. */
export function resultBodyLines(content: string): readonly StyledBodyLine[] {
  return bodyLines(content)
}

function bodyLines(content: string): readonly StyledBodyLine[] {
  const lines = content.split("\n")
  const shown = lines.slice(0, MAX_DETAIL_LINES).map((line) => plainLine(line))
  return lines.length > MAX_DETAIL_LINES
    ? [
        ...shown,
        plainLine(`… ${lines.length - MAX_DETAIL_LINES} more lines`, UI.textDim),
      ]
    : shown
}

function detailPlainText(detail: readonly StyledBodyLine[]): string {
  return detail
    .map((line) => line.map((segment) => segment.text).join("").trim())
    .join("\n")
    .trim()
}

/**
 * A body worth an expand affordance: one that says something the summary does
 * not. An expansion that restates its own summary is worse than no expansion,
 * so it is dropped here rather than painted with an arrow behind it.
 */
function revealing(
  summary: string,
  detail: readonly StyledBodyLine[],
): readonly StyledBodyLine[] | undefined {
  if (detail.length === 0) return undefined
  return detailPlainText(detail) === summary.trim() ? undefined : detail
}

type ResultSummary = {
  readonly summary: string
  readonly detail?: readonly StyledBodyLine[]
}

/** One catalogue entry: the tool's name and what it is for — never its schema. */
const TOOL_CARD = /^- ([^\s:]+):?\s*(.*)$/

/**
 * A capability search answers with one card per tool, each carrying a full JSON
 * input schema. The schema is for the model, never for the transcript, so the
 * row counts the catalogue and the expansion lists names only.
 */
function toolCatalogueSummary(content: string): ResultSummary | null {
  const cards = content
    .split("\n")
    .map((line) => TOOL_CARD.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
  if (cards.length === 0) return null

  const servers = new Set(
    cards
      .map((card) => parseMcpToolName(card[1] ?? "")?.server)
      .filter((server): server is string => server !== undefined),
  )
  const summary =
    servers.size > 0
      ? `Found ${countNoun(cards.length, "tool")} across ${countNoun(servers.size, "server")}`
      : `Found ${countNoun(cards.length, "tool")}`
  const detail = cards.slice(0, MAX_DETAIL_LINES).map((card): StyledBodyLine => {
    const rawName = card[1] ?? ""
    const name = isMcpToolName(rawName) ? humanizeMcpTool(rawName) : rawName
    // The catalogue text sometimes leads its description with the same
    // "[server]" tag the humanised name already carries as its prefix; drop it
    // so the server is not said twice.
    const description = cut((card[2] ?? "").replace(/^\[[^\]]+\]\s*/, ""))
    return description.length > 0
      ? [
          { text: name, fg: UI.inFlightBright },
          { text: `  ${description}`, fg: UI.textDim },
        ]
      : [{ text: name, fg: UI.inFlightBright }]
  })
  return { summary, detail }
}

/** `Grabbed 10 Linear issues` — the count and the noun, not the query. */
function recordsSummary(toolName: string, records: McpRecords): string {
  const parsed = parseMcpToolName(toolName)
  const noun =
    records.label !== "items"
      ? records.label
      : (parsed !== null ? nounFromToolName(parsed.server, parsed.tool) : undefined) ?? "items"
  const owner = parsed === null ? "" : `${titleCase(parsed.server)} `
  return `Grabbed ${records.items.length} ${owner}${records.items.length === 1 ? singular(noun) : plural(noun)}`
}

/** `Read Linear project Alpha` — the thing, named. */
function recordSummary(
  toolName: string,
  record: Record<string, unknown>,
): string {
  const parsed = parseMcpToolName(toolName)
  const noun =
    parsed !== null ? singular(nounFromToolName(parsed.server, parsed.tool) ?? "record") : "record"
  const owner = parsed === null ? "" : `${titleCase(parsed.server)} `
  const title = firstScalar(record, TITLE_FIELDS)
  return `Read ${owner}${noun}${title === undefined ? "" : ` ${cut(title)}`}`
}

/**
 * The one-sentence summary a tool result collapses to, derived from the shape
 * of what came back rather than from the call that asked for it. Null means the
 * body is short enough (or literal enough) to read as itself.
 */
function resultSummary(input: ToolResultRowInput): ResultSummary | null {
  const content = input.content
  if (input.name === TASK_TOOL) {
    // A worker's reply wraps a "Sub-agent ... reported:" / "## Summary"
    // envelope. The one-line preview already strips it; the expanded detail
    // must too, or the raw envelope and heading markers leak as plain text.
    const { preview } = summarizeToolResult(input.name, content)
    return { summary: preview, detail: bodyLines(stripTaskReportEnvelope(content)) }
  }
  if (input.name === TOOL_SEARCH_TOOL) {
    const catalogue = toolCatalogueSummary(content)
    if (catalogue !== null) return catalogue
  }
  if (isMcpToolName(input.name)) {
    const records = extractMcpRecords(content)
    if (records !== null) return { summary: recordsSummary(input.name, records) }
    const record = extractMcpRecord(content)
    if (record !== null) return { summary: recordSummary(input.name, record) }
  }
  if (content.split("\n").length <= COLLAPSE_MIN_LINES) return null
  const { preview } = summarizeToolResult(input.name, content)
  if (preview.trim().length === 0) return null
  return { summary: preview, detail: bodyLines(content) }
}

/** The tool a skill load arrives through; its result body is the whole skill. */
const USE_SKILL_TOOL = "use_skill"

/**
 * Name of the skill a `use_skill` result loaded, read off the body the tool
 * returns. Display-only: a body that does not announce a skill (an error, a
 * future wording) simply does not collapse.
 */
function loadedSkillName(name: string, content: string): string | undefined {
  if (name !== USE_SKILL_TOOL) return undefined
  return /^Skill "([^"]+)"/.exec(content)?.[1]
}

/**
 * Build the transcript row for a tool result: one sentence about what came
 * back, with the body — an aligned MCP table, a catalogue, raw output — behind
 * the expand key. Errors are neither summarised nor collapsed: a failure is
 * exactly the thing nobody should have to press a key to read.
 */
export function toolResultRow(input: ToolResultRowInput): StreamRow {
  const failed = input.isError === true
  const base = {
    role: "tool" as const,
    text: input.content,
    meta: input.name,
    ...(input.callId !== undefined ? { callId: input.callId } : {}),
  }
  if (failed) return { ...base, failed: true }

  const skill = loadedSkillName(input.name, input.content)
  if (skill !== undefined) return { ...base, skill }

  const summarised = resultSummary(input)
  if (summarised === null) return base

  const structured = mcpStructuredView(input.name, input.content)
  const detail =
    summarised.detail === undefined
      ? undefined
      : revealing(summarised.summary, summarised.detail)
  return {
    ...base,
    summary: summarised.summary,
    ...(structured !== null ? { structured } : {}),
    ...(detail !== undefined ? { detail } : {}),
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
