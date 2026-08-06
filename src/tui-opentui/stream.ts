/**
 * Transcript stream row model — product skin styling for fake / real streams.
 * Plain rows paint via TextRenderable; markdown-bearing rows via MarkdownRenderable.
 */

import { SyntaxStyle } from "@opentui/core"

import type { DiffView } from "./diff.js"
import type { McpStructuredView } from "./mcp-view.js"

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

const ROLE_FG: Record<StreamRole, string> = {
  user: "#bb9af7",
  assistant: "#9ece6a",
  tool: "#7dcfff",
  system: "#565f89",
}

/**
 * Diff body palette. Additions reuse the assistant tone and context the system
 * tone so a diff reads as the same skin as every other transcript row;
 * removals take the product danger red already used for error chrome.
 */
export const DIFF_FG = {
  add: ROLE_FG.assistant,
  del: "#f7768e",
  context: ROLE_FG.system,
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
  default: { fg: ROLE_FG.assistant },
  conceal: { fg: ROLE_FG.system, dim: true },
  "markup.heading": { fg: "#7aa2f7", bold: true },
  "markup.strong": { fg: "#e0af68", bold: true },
  "markup.italic": { fg: ROLE_FG.assistant, italic: true },
  "markup.strikethrough": { fg: ROLE_FG.system },
  "markup.raw": { fg: ROLE_FG.tool },
  "markup.list": { fg: "#7aa2f7" },
  "markup.quote": { fg: ROLE_FG.system, italic: true },
  "markup.link": { fg: "#7dcfff", underline: true },
  "markup.link.label": { fg: "#7dcfff" },
  "markup.link.url": { fg: "#7dcfff", underline: true },
  keyword: { fg: "#bb9af7" },
  string: { fg: "#9ece6a" },
  number: { fg: "#ff9e64" },
  comment: { fg: ROLE_FG.system, italic: true },
  function: { fg: "#7aa2f7" },
  type: { fg: "#2ac3de" },
  variable: { fg: "#c0caf5" },
  punctuation: { fg: "#89ddff" },
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

/** Hint line under the prompt (locked product bindings). */
export const PROMPT_HINT =
  "Enter queue · Alt+Enter steer · Ctrl+C stop" as const

/** Header chrome for product-skin demo sessions. */
export function sessionHeaderTitle(
  title: string,
  run: "idle" | "busy",
): string {
  const tag = run === "busy" ? "BUSY" : "IDLE"
  return `${title} · ${tag}`
}
