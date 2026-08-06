/**
 * Transcript stream row model — product skin styling for fake / real streams.
 * Plain rows paint via TextRenderable; markdown-bearing rows via MarkdownRenderable.
 */

import { SyntaxStyle } from "@opentui/core"

import type { DiffView } from "./diff.js"
import type { McpStructuredView } from "./mcp-view.js"
import { UI } from "./theme.js"

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

const ROLE_LABEL: Record<StreamRole, string> = {
  user: "you",
  assistant: "agent",
  tool: "tool",
  system: "sys",
}

/** Format a stream row for the transcript (prefix + body, role color). */
export function paintStreamRow(row: StreamRow): PaintedStreamLine {
  const label = ROLE_LABEL[row.role]
  const meta = row.meta && row.meta.length > 0 ? ` ${row.meta}` : ""
  const body = row.text
  return {
    content: ` ${label}${meta}  ${body}`,
    fg: ROLE_FG[row.role],
  }
}

/** Whether this row's body should render as markdown rather than literal text. */
export function isMarkdownRow(row: StreamRow): boolean {
  if (row.structured !== undefined || row.diff !== undefined) return false
  return row.markdown ?? row.role === "assistant"
}

/** Whether this row paints a structured table body instead of its text. */
export function isStructuredRow(row: StreamRow): boolean {
  return row.structured !== undefined
}

/** Whether this row paints a diff body instead of its text. */
export function isDiffRow(row: StreamRow): boolean {
  return row.diff !== undefined
}

/** Gutter (label + meta) painted beside a markdown body. */
export function streamRowGutter(row: StreamRow): PaintedStreamLine {
  const meta = row.meta && row.meta.length > 0 ? ` ${row.meta}` : ""
  return {
    content: ` ${ROLE_LABEL[row.role]}${meta}  `,
    fg: ROLE_FG[row.role],
  }
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
