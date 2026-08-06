/**
 * Human-readable tool arguments for the transcript.
 *
 * Raw JSON arguments are the single loudest thing a transcript can paint and
 * the least readable, so a call shows what it *is* — a path, a command, the
 * shape of a view — and keeps the structured form behind the expand key.
 *
 * The summary wording comes from `tui/tool-formatter`, which already knows how
 * every first-party tool is shaped; the expanded view tree comes from
 * `tui/view`, which already knows how to lay one out. Neither is re-derived
 * here: this module only maps them onto the OpenTUI palette and row model.
 */

import type { SemanticRole } from "../tui/theme.js"
import { summarizeToolArgs } from "../tui/tool-formatter.js"
import { validateView, viewToLines, type ViewNode } from "../tui/view/index.js"
import type { StyledBodyLine } from "./stream.js"
import { UI } from "./theme.js"

/** A summarised call: the collapsed line, and the body the expand key reveals. */
export type ToolArgsView = {
  readonly summary: string
  readonly detail: readonly StyledBodyLine[]
}

/**
 * View roles in the Corbits terminal palette. Warning and danger both land on
 * the action orange for the same reason the MCP table does: there is no red in
 * the brand system, and no decision marker competes on these rows.
 */
const ROLE_FG: Partial<Record<SemanticRole, string>> = {
  accent: UI.inFlightBright,
  brand: UI.action,
  success: UI.done,
  warning: UI.actionDim,
  danger: UI.action,
  muted: UI.textDim,
  dim: UI.textFaint,
  emphasis: UI.text,
}

function viewFg(role: SemanticRole): string {
  return ROLE_FG[role] ?? UI.text
}

/** Columns an expanded body is laid out for; the paint layer wraps the rest. */
export const TOOL_DETAIL_WIDTH = 88

/** A tall expansion is still a transcript row, not a pager. */
const MAX_DETAIL_LINES = 60

function parseObject(raw: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null
  }
  return parsed as Record<string, unknown>
}

/**
 * The view tree a call carries, either as its whole argument object or under a
 * `view` key. Validated rather than duck-typed: an unvalidated tree would reach
 * a renderer that trusts its shape.
 */
function viewArgument(args: Record<string, unknown>): ViewNode | null {
  const candidate = "view" in args ? args.view : args
  const result = validateView(candidate)
  return result.ok ? result.node : null
}

function countByType(node: ViewNode, into: Map<string, number>): void {
  const children =
    node.type === "stack" || node.type === "row" || node.type === "box"
      ? node.children
      : node.type === "grid"
        ? node.rows.flat()
        : []
  for (const child of children) {
    into.set(child.type, (into.get(child.type) ?? 0) + 1)
    countByType(child, into)
  }
}

/** A view tree by shape: its root, then what it is made of. */
export function describeView(node: ViewNode): string {
  const counts = new Map<string, number>()
  countByType(node, counts)
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([type, n]) => `${n} ${type} node${n === 1 ? "" : "s"}`)
  return parts.length === 0 ? node.type : `${node.type} · ${parts.join(" · ")}`
}

function viewDetail(node: ViewNode): readonly StyledBodyLine[] {
  return viewToLines(node, TOOL_DETAIL_WIDTH, viewFg)
    .slice(0, MAX_DETAIL_LINES)
    .map((line) =>
      line.map((segment) => ({
        text: segment.text,
        fg: segment.color ?? UI.text,
        ...(segment.bold === true ? { bold: true } : {}),
      })),
    )
}

function isScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
}

/**
 * Scalar arguments as `key  value` pairs with their newlines intact — a shell
 * command or a prompt is written to be read as text, and pretty-printed JSON
 * would hand it back with its line breaks escaped.
 */
function scalarDetail(args: Record<string, unknown>): readonly StyledBodyLine[] | null {
  const entries = Object.entries(args)
  if (entries.length === 0 || !entries.every(([, value]) => isScalar(value))) {
    return null
  }
  const lines: StyledBodyLine[] = []
  for (const [key, value] of entries) {
    const text = typeof value === "string" ? value : JSON.stringify(value)
    const rows = (text ?? "null").split("\n")
    rows.forEach((row, i) => {
      lines.push(
        i === 0
          ? [
              { text: `${key}: `, fg: UI.textDim },
              { text: row, fg: UI.text },
            ]
          : [{ text: `${" ".repeat(key.length + 2)}${row}`, fg: UI.text }],
      )
    })
  }
  return lines.slice(0, MAX_DETAIL_LINES)
}

function jsonDetail(value: unknown): readonly StyledBodyLine[] {
  return JSON.stringify(value, null, 2)
    .split("\n")
    .slice(0, MAX_DETAIL_LINES)
    .map((line) => [{ text: line, fg: UI.text }])
}

/** Arguments short enough to read inline are left alone rather than summarised. */
const INLINE_MAX = 60

/**
 * The summary/detail pair for a tool call's arguments, or null when the call
 * has nothing worth hiding — short literal arguments read better as themselves
 * than as a summary with an expand hint attached.
 */
export function toolArgsView(name: string, rawArgs: string): ToolArgsView | null {
  const raw = rawArgs.trim()
  if (raw.length === 0) return null
  const args = parseObject(raw)

  if (args !== null) {
    const view = viewArgument(args)
    if (view !== null) {
      return { summary: describeView(view), detail: viewDetail(view) }
    }
  }

  if (args === null && raw.length <= INLINE_MAX && !raw.includes("\n")) return null

  const { summary } = summarizeToolArgs(name, raw)
  if (summary.length === 0) return null
  if (args === null) return { summary, detail: jsonDetail(raw) }
  return { summary, detail: scalarDetail(args) ?? jsonDetail(args) }
}
