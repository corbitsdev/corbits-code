/**
 * Transcript stream row model — product skin styling for fake / real streams.
 * Plain rows paint via TextRenderable; markdown-bearing rows via MarkdownRenderable.
 */

import { SyntaxStyle } from "@opentui/core"

import { stringWidth, wrapLines } from "../tui/view/height.js"
import type { DiffView } from "./diff.js"
import type { McpStructuredView } from "./mcp-view.js"
import { thinkingScrollLine, thoughtPhrase, type Thought } from "./thinking.js"
import { UI } from "./theme.js"

/**
 * One line of a pre-coloured body (an expanded tool call's structured
 * arguments). Styled runs are painted as authored rather than re-parsed, so a
 * body that already knows its own colours keeps them.
 */
export type StyledBodyLine = readonly {
  readonly text: string
  readonly fg: string
  readonly bold?: boolean
}[]

export type StreamRole = "user" | "assistant" | "tool" | "system"

export type StreamRow = {
  readonly role: StreamRole
  readonly text: string
  /** Optional secondary label (tool name, timestamp, etc.). */
  readonly meta?: string
  /**
   * Force markdown on/off for this row. Defaults by role: only assistant
   * text is authored as markdown — tool output, user echo and system chrome
   * are literal and must not be reflowed or have markers concealed.
   */
  readonly markdown?: boolean
  /**
   * Row body is still being appended to. Markdown rows keep their trailing
   * block unstable so a half-received fence/table is not finalized early.
   */
  readonly streaming?: boolean
  /**
   * Structured cell grid (MCP record list / record detail). Painted as a table
   * instead of the row body, which would otherwise be a raw JSON dump.
   */
  readonly structured?: McpStructuredView
  /**
   * Rendered file-edit diff. Painted instead of the row body, which would
   * otherwise be the edit tool's raw JSON arguments.
   */
  readonly diff?: DiffView
  /**
   * Tool call that came back an error. Carried as a flag rather than baked
   * into `meta` so the paint layer can mark the row without parsing a label.
   */
  readonly failed?: boolean
  /**
   * Tool row that answers a call rather than opening one. Painted as a
   * continuation of the call above it instead of repeating its name.
   */
  readonly result?: boolean
  /**
   * Writer of a non-user row. Absent means the session's own agent; the paint
   * layer names writers only once a transcript carries more than one.
   */
  readonly agent?: string
  /**
   * Name of the skill a `use_skill` result loaded. Present only on rows whose
   * body is skill instructions, which collapse to a summary until expanded.
   */
  readonly skill?: string
  /**
   * Human summary of a tool call's arguments. Present means the row paints the
   * summary instead of `text`, which is the raw argument JSON.
   */
  readonly summary?: string
  /** Structured body a summarised call reveals when expanded. */
  readonly detail?: readonly StyledBodyLine[]
  /** Settled reasoning: what the row collapses to once thinking is done. */
  readonly thought?: Thought
  /**
   * Bounded-rate reveal position for a still-streaming reasoning row — how far
   * into `text` the scroll line is allowed to show. Absent means show it all
   * (a settled row, a hydrated transcript, a fixture with no clock driving it).
   */
  readonly revealChars?: number
  /** Whether a collapsible body is currently showing in full. */
  readonly expanded?: boolean
  /**
   * Leading verb of a tool row read as a sentence ("Read", "Created", "$" for
   * a shell command). Present means the row paints verb + coloured subject
   * (`summary`) instead of the legacy meta-column layout.
   */
  readonly verb?: string
  /** Diff stat or line range painted dim after the subject, e.g. "+1/-0". */
  readonly stat?: string
}

/**
 * What a row needs to know about the surface it paints onto: the transcript's
 * column budget (right-aligned bubbles and wrapped bodies are computed, not
 * delegated to the renderer) and whether writers have to be named at all.
 */
export type RowLayout = {
  readonly width: number
  readonly multiAgent: boolean
}

/** Writer of a row when none is named: the session's own agent. */
export const MAIN_AGENT = "agent"

/**
 * Key name that expands a collapsed body — combined with Alt in the
 * transcript so the prompt (which almost always holds focus) can never
 * swallow it as a typed letter. The approval overlay's own collapsed
 * payloads answer to the same key name but stay bare there: that overlay is
 * modal and the prompt cannot have focus while it is open.
 */
export const EXPAND_KEY = "e"

/** Display label for the transcript/overlay row expand affordance. */
export const EXPAND_HINT_LABEL = "Alt+E"

/** Distinct writers in a transcript. Role labels are worth their columns only above one. */
export function agentVoicesIn(rows: readonly StreamRow[]): ReadonlySet<string> {
  const voices = new Set<string>()
  for (const row of rows) {
    if (row.role === "user") continue
    voices.add(row.agent ?? MAIN_AGENT)
  }
  return voices
}

export function isMultiAgent(rows: readonly StreamRow[]): boolean {
  return agentVoicesIn(rows).size > 1
}

export type PaintedStreamLine = {
  readonly content: string
  readonly fg: string
}

/**
 * Transcript rows are text, so they take the element cream. Only the tool role
 * is tinted — it is machine output threaded through a human conversation, and
 * Summit Blue separates it without adding a second voice.
 */
const ROLE_FG: Record<StreamRole, string> = {
  user: UI.text,
  assistant: UI.text,
  tool: UI.inFlight,
  system: UI.textDim,
}

/**
 * Diff body palette. This is the one place orange is not the decision marker:
 * a diff is content, and add/remove is the brand's own green/orange pair.
 */
export const DIFF_FG = {
  add: UI.done,
  del: UI.action,
  context: UI.textDim,
} as const

/**
 * Meta column (tool name, `queue`, `error`). Fixed so a tool call's argument
 * and a tool result's payload start on the same column and can be scanned as
 * one list rather than a ragged log.
 */
const META_WIDTH = 12

/**
 * The mark column carries what colour is not allowed to: cream is shared by the
 * user and the agent (three-accent limit), so a failed tool call is found by
 * its cross and the operator's own turn by its bubble bar.
 */
const MARK_OK = "✓"
const MARK_FAILED = "×"

/**
 * Glyphs are single-cell so nothing after them can slip out of the meta column.
 * Every one is verified against `stringWidth` by the row-shape tests.
 */
const BUBBLE_BAR = "▍"
const THINKING_BAR = "┆"
const RESULT_CONNECTOR = "└"
const AGENT_ICON = "●"

/**
 * Blank columns where a per-tool-family glyph used to sit. A tool row leads
 * with one success/failure marker now (not a glyph column keyed off tool
 * type), but the width is kept so the meta column and the result connector
 * beneath it still land on the same column.
 */
const TOOL_LEAD_GAP = "  "

/** Thinking is coalesced chain-of-thought, not an answer — it paints faintest. */
export function isThinkingRow(row: StreamRow): boolean {
  return row.role === "system" && row.meta === "thinking"
}

function rowFg(row: StreamRow): string {
  if (isThinkingRow(row)) return UI.textFaint
  // A failed call steps out of the live tool voice; the cross carries the rest.
  if (row.failed === true) return UI.textDim
  return ROLE_FG[row.role]
}

/**
 * Pad-only: a meta longer than the column (an edit summary carries its path and
 * line counts) pushes the body rather than being truncated. Losing the column
 * on those rows costs less than losing the information.
 */
function fitMeta(meta: string): string {
  return meta.length >= META_WIDTH ? `${meta} ` : meta.padEnd(META_WIDTH)
}

/**
 * Block label shown once above the first row of a run of consecutive rows
 * from the same writer. `rowGroupGap` already treats a change of writer (or
 * role) as a turn boundary, so a block is exactly a gap-free run and needs no
 * separate bookkeeping: the label repeats only where the gap does.
 */
export function blockLabel(
  previous: StreamRow | undefined,
  row: StreamRow,
  layout: RowLayout,
): string | null {
  if (!layout.multiAgent || row.role === "user") return null
  if (previous !== undefined && rowGroupGap(previous, row) === 0) return null
  return `${AGENT_ICON} ${row.agent ?? MAIN_AGENT}`
}

/**
 * Tool prefix: a single success/failure mark, then either the sentence-row's
 * bare lead (verb + coloured subject follow in the body) or the legacy meta
 * column. A result trades the lead for a connector and leaves the meta column
 * blank, so the call and its answer read as one block instead of the tool
 * name twice. Writer identity is painted once per block (see `blockLabel`),
 * not repeated on every row.
 */
function toolPrefix(row: StreamRow): string {
  const mark = row.failed === true ? MARK_FAILED : MARK_OK
  if (row.result === true) {
    return `${mark} ${RESULT_CONNECTOR} ${" ".repeat(META_WIDTH)}`
  }
  if (row.verb !== undefined) return `${mark} `
  const meta = row.meta && row.meta.length > 0 ? fitMeta(row.meta) : ""
  return `${mark} ${TOOL_LEAD_GAP}${meta}`
}

/** Columns the operator's bubble may claim before it wraps. */
const BUBBLE_MAX_SHARE = 0.75

/**
 * The operator's turn as a block hugging the left gutter, same as an answer,
 * with the bar down its left edge. The bar (not alignment) is what makes a
 * user turn findable now that both voices share cream and the left edge; the
 * body sits two columns past it so the boundary reads even at a glance.
 */
function userBubbleLines(text: string, width: number): string[] {
  const bar = `${BUBBLE_BAR} `
  const barWidth = stringWidth(bar)
  const body = Math.max(1, Math.min(width - barWidth, Math.ceil(width * BUBBLE_MAX_SHARE)))
  const lines = text.split("\n").flatMap((line) => wrapLines(line, body))
  return lines.map((line) => `${bar}${line}`)
}

/** Columns a reasoning block is inset by, so it reads as subordinate. */
const THINKING_INDENT = 2

/**
 * Reasoning as a structured block rather than one dim line: indented, with a
 * marker down its left edge, so a long chain of thought is skimmable and
 * obviously not the answer.
 */
function thinkingLines(text: string, layout: RowLayout): string[] {
  const marker = `${THINKING_BAR} `
  const lead = " ".repeat(THINKING_INDENT)
  const gutter = stringWidth(lead) + stringWidth(marker)
  const lines = text
    .split("\n")
    .flatMap((line) => wrapLines(line, Math.max(1, layout.width - gutter)))
  return lines.map((line) => `${lead}${marker}${line}`)
}

/** Trailer that tells a collapsed row it has more behind it, and how to get there. */
function expandHint(expanded: boolean): string {
  return ` · ${EXPAND_HINT_LABEL} ${expanded ? "collapse" : "expand"}`
}

/** Small arrow affordance for a sentence-style tool row: absent, ▸, or ▾. */
function toolArrow(row: StreamRow): string {
  if (!isCollapsibleRow(row)) return ""
  return row.expanded === true ? "▾" : "▸"
}

/**
 * Reasoning body. While it streams it is one row windowed onto the newest text;
 * once it has settled it is the phrase it earned, with the full chain of thought
 * behind the expand key. A row with no settled thought (a hydrated transcript,
 * a fixture) keeps the plain block — there is no elapsed time to summarise.
 */
function reasoningLines(row: StreamRow, layout: RowLayout): string[] {
  const lead = " ".repeat(THINKING_INDENT)
  if (row.streaming === true) {
    const marker = `${THINKING_BAR} `
    const columns = Math.max(1, layout.width - stringWidth(lead) - stringWidth(marker))
    return [`${lead}${marker}${thinkingScrollLine(row.text, columns, row.revealChars)}`]
  }
  if (row.thought === undefined) return thinkingLines(row.text, layout)
  const expanded = row.expanded === true
  const head = `${lead}${thoughtPhrase(row.thought.ms, row.thought.variant)}${expandHint(expanded)}`
  return expanded ? [head, ...thinkingLines(row.text, layout)] : [head]
}

/** Body a collapsible row shows: the summary alone, or the full text plus the way back. */
function collapsibleBody(row: StreamRow, skill: string): string {
  const lines = row.text.split("\n").length
  const summary = `skill "${skill}" loaded · ${lines} line${lines === 1 ? "" : "s"}`
  return row.expanded === true
    ? `${summary}${expandHint(true)}\n${row.text}`
    : `${summary}${expandHint(false)}`
}

/** Plain-text rendering of a styled body, for text frames and the clipboard. */
function detailPlainLines(detail: readonly StyledBodyLine[]): string[] {
  return detail.map((line) => line.map((segment) => segment.text).join("").trimEnd())
}

/** The head line of a summarised tool call: what it did, and the way in. */
export function summaryHead(row: StreamRow, summary: string): string {
  return `${summary}${row.detail === undefined ? "" : expandHint(row.expanded === true)}`
}

/** The text a row paints, after collapsing anything that hides behind a summary. */
function rowBody(row: StreamRow): string {
  if (row.skill !== undefined) return collapsibleBody(row, row.skill)
  if (row.summary === undefined) return row.text
  const head = summaryHead(row, row.summary)
  if (row.expanded !== true || row.detail === undefined) return head
  return [head, ...detailPlainLines(row.detail)].join("\n")
}

/** Columns a sentence-row's expanded detail/diff is inset by beneath the head. */
const TOOL_DETAIL_INDENT = 2

/** Continuation line indent for a wrapped `&&`-chained shell command. */
const CHAIN_INDENT = "    "

/**
 * A shell command's `&&` chain, one segment per line with the connector
 * trailing each line but the last — legible whether the row is collapsed or
 * expanded, since the chain itself is never what the expand key hides.
 */
function shellChainSegments(command: string): readonly string[] {
  return command.includes(" && ") ? command.split(" && ") : [command]
}

/**
 * The always-visible head of a sentence-style tool row: mark (painted by
 * `toolPrefix`, not here) followed by verb + coloured subject, an optional
 * dim stat, and the expand arrow on its last physical line. A shell command's
 * `&&` chain spans several lines; every other tool call is one line.
 */
export function toolSentenceLines(row: StreamRow): StyledBodyLine[] {
  const fg = rowFg(row)
  const verb = row.verb ?? ""
  const subject = row.summary ?? row.text
  const segments = shellChainSegments(subject)
  // A verb that already names the whole call ("Linear: list issues") has no
  // subject to pair with, and a lone subject (a result sentence) has no verb.
  const head = verb.length === 0 ? "" : subject.length === 0 ? verb : `${verb} `
  const lines: StyledBodyLine[] = segments.map((segment, i) => {
    const lead: StyledBodyLine =
      i === 0 ? [{ text: head, fg }] : [{ text: CHAIN_INDENT, fg }]
    const isLast = i === segments.length - 1
    const body: StyledBodyLine = [{ text: segment, fg: UI.inFlightBright }]
    const chain: StyledBodyLine = isLast ? [] : [{ text: " && \\", fg: UI.textDim }]
    return [...lead, ...body, ...chain]
  })
  const last = lines[lines.length - 1] ?? []
  const stat = row.stat !== undefined && row.stat.length > 0 ? [{ text: ` ${row.stat}`, fg: UI.textDim }] : []
  const arrow = toolArrow(row)
  const arrowSegment = arrow.length > 0 ? [{ text: ` ${arrow}`, fg: UI.textDim }] : []
  lines[lines.length - 1] = [...last, ...stat, ...arrowSegment]
  return lines
}

/** A styled body line, indented by `columns` for a row's expanded detail. */
function indentStyledLine(line: StyledBodyLine, columns: number): StyledBodyLine {
  return [{ text: " ".repeat(columns), fg: UI.text }, ...line]
}

/**
 * Full painted body of a sentence-style tool row: the head, plus its diff or
 * structured detail indented beneath once expanded. Collapsing hides only
 * this tail — the head (and a shell chain's full structure) always shows.
 */
export function toolRowLines(row: StreamRow): StyledBodyLine[] {
  const head = toolSentenceLines(row)
  if (row.expanded !== true) return head
  const tail =
    row.diff !== undefined
      ? row.diff.lines
      : row.detail !== undefined
        ? row.detail
        : []
  return [...head, ...tail.map((line) => indentStyledLine(line, TOOL_DETAIL_INDENT))]
}

/**
 * Format a stream row for the transcript. Content may span several lines: the
 * operator's bubble and a reasoning block are laid out here rather than left to
 * the renderer, which cannot right-align or inset a wrapped body.
 */
export function paintStreamRow(
  row: StreamRow,
  layout: RowLayout,
): PaintedStreamLine {
  const fg = rowFg(row)
  if (row.role === "user") {
    return { content: userBubbleLines(row.text, layout.width).join("\n"), fg }
  }
  if (isThinkingRow(row)) {
    return {
      content: reasoningLines(row, layout).join("\n"),
      fg,
    }
  }
  const gutter = streamRowGutter(row, layout).content
  return { content: `${gutter}${indentBody(rowBody(row), gutter, layout)}`, fg }
}

/**
 * A body laid out under its own column: wrapped to the columns left beside the
 * prefix and indented onto them. Left to the renderer, a long line (raw tool
 * arguments, a wide result) wraps to column 0 — outside the shell's gutter and
 * outside the meta column — which breaks the one alignment the transcript has.
 */
function indentBody(text: string, gutter: string, layout: RowLayout): string {
  const lead = stringWidth(gutter)
  const columns = Math.max(1, layout.width - lead)
  const lines = text.split("\n").flatMap((line) => wrapLines(line, columns))
  return lines.join(`\n${" ".repeat(lead)}`)
}

/** Blank rows painted above a row that opens a new group. */
export const ROW_GROUP_GAP = 1

/** Writer of a row for gap/grouping purposes; the operator has no writer. */
function gapWriter(row: StreamRow): string | null {
  return row.role === "user" ? null : row.agent ?? MAIN_AGENT
}

/**
 * Vertical rhythm between transcript rows. A turn boundary (a different voice,
 * a different writer, or a different tool call) earns a blank row so the eye
 * can find it; a thinking row never does, so the coalesced line appearing or
 * disappearing above an answer cannot shift what is already on screen.
 */
export function rowGroupGap(
  previous: StreamRow | undefined,
  row: StreamRow,
): number {
  if (previous === undefined) return 0
  // Thinking leads the answer it belongs to, so it takes the turn's gap rather
  // than opening one of its own: the pair occupies the same rows whether or not
  // the thinking line is there.
  if (isThinkingRow(row)) return previous.role === "user" ? ROW_GROUP_GAP : 0
  if (isThinkingRow(previous)) return 0
  if (previous.role !== row.role) return ROW_GROUP_GAP
  // A block is a contiguous run from one writer; a change of writer is a
  // fresh block even when the role stays the same (one agent's tool call
  // followed by another agent's, say).
  if (gapWriter(previous) !== gapWriter(row)) return ROW_GROUP_GAP
  // Same voice, different call: a result stays glued to the call it answers,
  // but the next call starts its own block.
  if (row.role === "tool" && (previous.meta ?? "") !== (row.meta ?? "")) {
    return ROW_GROUP_GAP
  }
  return 0
}

/** Whether this row's body should render as markdown rather than literal text. */
export function isMarkdownRow(row: StreamRow): boolean {
  if (row.structured !== undefined || row.diff !== undefined) return false
  if (isDetailRow(row)) return false
  // The operator's turn is a laid-out bubble, which a markdown body would
  // re-wrap and left-align out of the right gutter.
  if (row.role === "user") return false
  return row.markdown ?? row.role === "assistant"
}

/** Whether this row paints a structured table body instead of its text. */
export function isStructuredRow(row: StreamRow): boolean {
  return row.structured !== undefined
}

/**
 * Whether this row reads as a sentence — verb plus coloured subject, with an
 * arrow when there is something behind it. Calls earn it from their verb;
 * results earn it from the sentence their payload was summarised into.
 */
export function isSentenceRow(row: StreamRow): boolean {
  if (row.role !== "tool") return false
  return row.verb !== undefined || (row.result === true && row.summary !== undefined)
}

/** Whether this row paints a diff body instead of its text. */
export function isDiffRow(row: StreamRow): boolean {
  return row.diff !== undefined
}

/** Whether this row paints a styled structured body (an opened tool call). */
export function isDetailRow(row: StreamRow): boolean {
  return row.detail !== undefined && row.expanded === true
}

/**
 * Whether the expand key has anything to do on this row. One idiom across the
 * product: a loaded skill, a summarised tool call and settled reasoning all
 * answer to the same key and say so on their collapsed line.
 */
export function isCollapsibleRow(row: StreamRow): boolean {
  if (row.skill !== undefined) return true
  if (row.summary !== undefined && row.detail !== undefined) return true
  if (row.summary !== undefined && row.structured !== undefined) return true
  if (row.diff !== undefined) return true
  return isThinkingRow(row) && row.thought !== undefined && row.streaming !== true
}

/**
 * Prefix painted beside a body the renderer owns (markdown, table, diff).
 * Empty for a lone agent's own prose: with nothing to disambiguate, the answer
 * starts on the first column. Writer identity is a block-level header, not a
 * per-row prefix — see `blockLabel`.
 */
export function streamRowGutter(
  row: StreamRow,
  layout: RowLayout,
): PaintedStreamLine {
  const fg = rowFg(row)
  if (row.role === "tool") return { content: toolPrefix(row), fg }
  const meta =
    row.meta !== undefined && row.meta.length > 0 && !isThinkingRow(row)
      ? fitMeta(row.meta)
      : ""
  return { content: meta, fg }
}

/**
 * Markdown styling for transcript bodies, mapped onto the role palette so
 * markdown rows read as the same product skin as plain rows.
 * Native scope names: `markup.*` for markdown, the rest for fenced-code
 * syntax highlighting.
 */
const MARKDOWN_STYLES = {
  default: { fg: UI.text },
  conceal: { fg: UI.textFaint, dim: true },
  "markup.heading": { fg: UI.inFlightBright, bold: true },
  "markup.strong": { fg: UI.text, bold: true },
  "markup.italic": { fg: UI.text, italic: true },
  "markup.strikethrough": { fg: UI.textFaint },
  "markup.raw": { fg: UI.inFlight },
  "markup.list": { fg: UI.inFlightBright },
  "markup.quote": { fg: UI.textDim, italic: true },
  "markup.link": { fg: UI.inFlightBright, underline: true },
  "markup.link.label": { fg: UI.inFlightBright },
  "markup.link.url": { fg: UI.inFlightBright, underline: true },
  keyword: { fg: UI.inFlightBright },
  string: { fg: UI.done },
  number: { fg: UI.done },
  comment: { fg: UI.textFaint, italic: true },
  function: { fg: UI.inFlight },
  type: { fg: UI.inFlightBright },
  variable: { fg: UI.text },
  punctuation: { fg: UI.textDim },
} as const

let cachedSyntaxStyle: SyntaxStyle | null = null

/**
 * Shared transcript SyntaxStyle. Lazy because construction reaches into the
 * native render lib, which is unavailable until a renderer exists.
 */
export function transcriptSyntaxStyle(): SyntaxStyle {
  if (cachedSyntaxStyle === null) {
    cachedSyntaxStyle = SyntaxStyle.fromStyles({ ...MARKDOWN_STYLES })
  }
  return cachedSyntaxStyle
}
