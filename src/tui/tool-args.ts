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

import { isMcpToolName } from "../mcp/tool-name.js"
import type { SemanticRole } from "./semantic-theme.js"
import { summarizeToolArgs } from "./tool-formatter.js"
import { validateView, viewToLines, type ViewNode } from "./view/index.js"
import type { StyledBodyLine } from "./stream.js"
import { UI } from "./theme.js"

/**
 * A summarised call: the collapsed line, and the body the expand key reveals.
 * An empty summary means the row's verb already names the whole call and a
 * subject would only repeat it; an absent detail means there is nothing behind
 * the summary worth an arrow.
 */
export type ToolArgsView = {
  readonly summary: string
  readonly detail?: readonly StyledBodyLine[]
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
 * Scalar (or scalar-array) arguments as `key  value` pairs with their newlines
 * intact — a shell command or a spawn prompt is written to be read as text, and
 * pretty-printed JSON would hand it back with its line breaks escaped (CL-5762).
 *
 * Nested objects recurse one level so a task brief expands as fields rather than
 * a JSON dump; deeper nesting collapses to a compact token.
 */
function fieldDetail(
  args: Record<string, unknown>,
  indent = 0,
): readonly StyledBodyLine[] {
  const pad = " ".repeat(indent)
  const lines: StyledBodyLine[] = []
  for (const [key, value] of Object.entries(args)) {
    if (isScalar(value)) {
      const text = typeof value === "string" ? value : JSON.stringify(value)
      const rows = (text ?? "null").split("\n")
      rows.forEach((row, i) => {
        lines.push(
          i === 0
            ? [
                { text: `${pad}${key}: `, fg: UI.textDim },
                { text: row, fg: UI.text },
              ]
            : [{ text: `${pad}${" ".repeat(key.length + 2)}${row}`, fg: UI.text }],
        )
      })
      continue
    }
    if (Array.isArray(value) && value.every(isScalar)) {
      if (value.length === 0) {
        lines.push([
          { text: `${pad}${key}: `, fg: UI.textDim },
          { text: "[]", fg: UI.text },
        ])
        continue
      }
      lines.push([{ text: `${pad}${key}:`, fg: UI.textDim }])
      for (const item of value) {
        const text = typeof item === "string" ? item : JSON.stringify(item)
        for (const row of text.split("\n")) {
          lines.push([{ text: `${pad}  - ${row}`, fg: UI.text }])
        }
      }
      continue
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      // One level of nesting is enough for a spawn brief; deeper stays compact.
      if (indent === 0) {
        lines.push([{ text: `${pad}${key}:`, fg: UI.textDim }])
        lines.push(...fieldDetail(value as Record<string, unknown>, indent + 2))
      } else {
        lines.push([
          { text: `${pad}${key}: `, fg: UI.textDim },
          { text: "{…}", fg: UI.text },
        ])
      }
      continue
    }
    // Arrays of objects, etc. — compact rather than a wall of JSON.
    lines.push([
      { text: `${pad}${key}: `, fg: UI.textDim },
      {
        text: Array.isArray(value) ? `[${value.length} items]` : "{…}",
        fg: UI.text,
      },
    ])
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
 * Argument a call is *about*, most-meaningful first. A row's subject is one
 * value — the query, the command, the URL — because a transcript is scanned,
 * and a serialised argument list spends the row's columns on a second argument
 * that is then cut off mid-word ("numR…"). Everything else is behind the arrow.
 */
const SUBJECT_KEYS = [
  "command",
  "query",
  "url",
  // A search names what it searched for, not where: the path is the scope.
  "pattern",
  "path",
  "file_path",
  "prompt",
  "description",
  "name",
] as const

/** Columns a subject may claim before the paint layer cuts it to the row. */
const SUBJECT_MAX = 96

function flatten(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

/**
 * The one argument worth painting, or null when nothing scalar stands out.
 * Falls back to the first scalar argument so an unknown tool still reads as a
 * subject rather than as a key/value dump.
 */
function primarySubject(args: Record<string, unknown>): string | null {
  for (const key of SUBJECT_KEYS) {
    const value = args[key]
    if (typeof value === "string" && flatten(value).length > 0) {
      return flatten(value).slice(0, SUBJECT_MAX)
    }
  }
  const first = Object.entries(args).find(
    ([, value]) => typeof value === "string" && flatten(value).length > 0,
  )
  return first === undefined ? null : flatten(first[1] as string).slice(0, SUBJECT_MAX)
}

/**
 * Whether the formatter fell back to serialising the whole argument object.
 * Its per-tool cases (a shortened path, a task description) are better subjects
 * than anything picked here, and they never lead with `key: `.
 */
function isArgumentList(args: Record<string, unknown>, summary: string): boolean {
  return Object.keys(args).some((key) => summary.startsWith(`${key}: `))
}

/** The subject a summarised call paints: one argument, without its key. */
function subjectFor(
  name: string,
  raw: string,
  args: Record<string, unknown>,
): string {
  const { summary } = summarizeToolArgs(name, raw)
  // An empty formatter summary is not a subject — fall through to primarySubject
  // so a task without description still paints its prompt rather than raw JSON.
  if (summary.length > 0 && !isArgumentList(args, summary)) return summary
  return primarySubject(args) ?? summary
}

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
      return withDetail(describeView(view), viewDetail(view))
    }
  }

  // An MCP call's verb is already "Linear: list issues" — the whole sentence.
  // Its arguments are a query, not a subject: nobody reads a transcript for
  // the pagination cursor, so they belong behind the expand key or nowhere.
  if (args !== null && isMcpToolName(name)) {
    return withDetail("", fieldDetail(args))
  }

  if (args === null && raw.length <= INLINE_MAX && !raw.includes("\n")) return null

  if (args === null) {
    const { summary } = summarizeToolArgs(name, raw)
    return summary.length === 0 ? null : withDetail(summary, jsonDetail(raw))
  }
  const subject = subjectFor(name, raw, args)
  // Object args always get a summarised view — even with an empty subject the
  // verb alone names the call and the body expands with real line breaks. A
  // null return here is what used to dump raw argument JSON into the transcript.
  return withDetail(subject, fieldDetail(args))
}

/**
 * Pair a summary with a body only when the body says something the summary does
 * not. An expansion that restates its own collapsed line earns an arrow that
 * leads nowhere, which is worse than showing nothing.
 */
function withDetail(
  summary: string,
  detail: readonly StyledBodyLine[],
): ToolArgsView {
  const plain = detail
    .map((line) => line.map((segment) => segment.text).join("").trim())
    .join("\n")
    .trim()
  // A one-argument call whose subject *is* that argument reveals nothing but
  // the key it was already named by, so it earns no arrow.
  const bare = plain.includes("\n") ? plain : plain.replace(/^[A-Za-z_][\w.-]*:\s*/, "")
  return bare === summary.trim() ? { summary } : { summary, detail }
}
