/**
 * Edit-tool diff rendering for the OpenTUI transcript.
 *
 * File edits are the most common tool call in a coding turn, and their tool
 * result is only a confirmation string ("replaced 1 occurrence(s) in x.ts") —
 * the before/after text lives solely in the call's JSON arguments. So the diff
 * is derived from the arguments and carried on the tool row.
 *
 * Output is a plain segment model (text + palette colour) rather than the Ink
 * `StyledLine` shape: the OpenTUI row factory paints with `TextChunk`s, and a
 * neutral model keeps this module pure and headlessly testable without a
 * renderer. `shell.ts` maps segments to chunks at paint time.
 */

import { describeToolCall } from "../tui/tool-formatter.js"
// The one wrap implementation: a diff row soft-wraps by the same column rules
// as every other row, so a wide glyph cannot overflow the gutter here alone.
import { wrapRanges } from "../tui/view/height.js"
import { DIFF_FG, type StreamRow } from "./stream.js"
import { toolArgsView } from "./tool-args.js"

export type DiffRowKind = "add" | "del" | "context"
export type DiffRow = { readonly kind: DiffRowKind; readonly text: string }

/** One painted span of a diff line. */
export type DiffSegment = {
  readonly text: string
  readonly fg: string
  /** Set on intra-line changed tokens so the delta reads without a colour wash. */
  readonly bold?: boolean
}

export type DiffLine = readonly DiffSegment[]

/** A rendered diff plus its summary counts, carried on a StreamRow. */
export type DiffView = {
  readonly lines: readonly DiffLine[]
  readonly added: number
  readonly removed: number
  readonly path?: string
}

// A row plus its position in the old/new file. `collapsed` marks the "N
// unchanged lines" summary row inserted by collapseContext, which occupies no
// real line in either file and so carries no line numbers.
type NumberedRow = DiffRow & {
  oldNum?: number
  newNum?: number
  collapsed?: boolean
}

function lcsTable(a: readonly string[], b: readonly string[]): number[][] {
  const n = a.length
  const m = b.length
  const table: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  )
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] =
        a[i] === b[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }
  return table
}

/**
 * Longest-common-subsequence line diff. The classic dynamic-programming table
 * is fine here: edit hunks (old_string vs new_string) are small, and even a
 * whole-file write diffs against an empty side, so the quadratic cost never
 * bites in practice.
 */
export function diffLines(oldText: string, newText: string): DiffRow[] {
  const a = oldText.length === 0 ? [] : oldText.split("\n")
  const b = newText.length === 0 ? [] : newText.split("\n")
  const n = a.length
  const m = b.length
  const lcs = lcsTable(a, b)

  const rows: DiffRow[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ kind: "context", text: a[i]! })
      i++
      j++
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      rows.push({ kind: "del", text: a[i]! })
      i++
    } else {
      rows.push({ kind: "add", text: b[j]! })
      j++
    }
  }
  while (i < n) rows.push({ kind: "del", text: a[i++]! })
  while (j < m) rows.push({ kind: "add", text: b[j++]! })
  return rows
}

export function diffStat(
  oldText: string,
  newText: string,
): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const row of diffLines(oldText, newText)) {
    if (row.kind === "add") added++
    else if (row.kind === "del") removed++
  }
  return { added, removed }
}

const GUTTER: Record<DiffRowKind, string> = {
  add: "+ ",
  del: "- ",
  context: "  ",
}

function rowColor(kind: DiffRowKind): string {
  if (kind === "add") return DIFF_FG.add
  if (kind === "del") return DIFF_FG.del
  return DIFF_FG.context
}

// Attach each row's position in the old/new file before any collapsing, so a
// hidden stretch still leaves the surviving rows numbered correctly.
function numberRows(rows: readonly DiffRow[]): NumberedRow[] {
  let oldLine = 1
  let newLine = 1
  return rows.map((row) => {
    if (row.kind === "context") {
      return { ...row, oldNum: oldLine++, newNum: newLine++ }
    }
    if (row.kind === "del") return { ...row, oldNum: oldLine++ }
    return { ...row, newNum: newLine++ }
  })
}

// Collapse long unchanged stretches to a few lines of context on each side of a
// change so a large file write or a wide edit does not bury the actual delta.
function collapseContext(
  rows: readonly NumberedRow[],
  pad: number,
): NumberedRow[] {
  const keep = new Array<boolean>(rows.length).fill(false)
  rows.forEach((row, idx) => {
    if (row.kind === "context") return
    const from = Math.max(0, idx - pad)
    const to = Math.min(rows.length - 1, idx + pad)
    for (let k = from; k <= to; k++) keep[k] = true
  })

  const out: NumberedRow[] = []
  let hidden = 0
  const flush = (): void => {
    if (hidden > 0) {
      out.push({
        kind: "context",
        text: `… ${hidden} unchanged line${hidden === 1 ? "" : "s"}`,
        collapsed: true,
      })
      hidden = 0
    }
  }
  rows.forEach((row, idx) => {
    if (keep[idx]) {
      flush()
      out.push(row)
    } else {
      hidden++
    }
  })
  flush()
  return out
}

function tokenizeWords(line: string): string[] {
  return line.match(/\S+|\s+/g) ?? (line.length === 0 ? [] : [line])
}

/**
 * Token LCS over words/whitespace runs so a rename or argument swap only paints
 * the changed tokens, not the whole line. Emits segments for `line` only (the
 * side being rendered); tokens unique to `paired` are skipped on this pass.
 */
export function wordDiffSegments(
  line: string,
  kind: "add" | "del",
  paired: string,
): DiffSegment[] {
  const self = tokenizeWords(line)
  const other = tokenizeWords(paired)
  const changed = (text: string): DiffSegment => ({
    text,
    fg: rowColor(kind),
    bold: true,
  })
  if (self.length === 0) return [changed(line)]

  const lcs = lcsTable(self, other)
  const out: DiffSegment[] = []
  let i = 0
  let j = 0
  const n = self.length
  const m = other.length
  while (i < n && j < m) {
    if (self[i] === other[j]) {
      out.push({ text: self[i]!, fg: DIFF_FG.context })
      i++
      j++
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push(changed(self[i]!))
      i++
    } else {
      j++
    }
  }
  while (i < n) out.push(changed(self[i++]!))
  return out.length > 0 ? out : [changed(line)]
}

function sliceSegments(
  segments: readonly DiffSegment[],
  start: number,
  end: number,
): DiffSegment[] {
  const out: DiffSegment[] = []
  let pos = 0
  for (const seg of segments) {
    const segStart = pos
    const segEnd = pos + seg.text.length
    pos = segEnd
    const from = Math.max(start, segStart)
    const to = Math.min(end, segEnd)
    if (to > from) {
      out.push({ ...seg, text: seg.text.slice(from - segStart, to - segStart) })
    }
  }
  return out
}

export type DiffRenderOptions = {
  /**
   * Lines of unchanged context to keep around each change. Undefined keeps the
   * diff uncollapsed (the right call for small localized edit hunks).
   */
  readonly contextLines?: number
  /**
   * Hide the old/new line-number gutter. edit_file hunks diff old_string
   * against new_string, so their row indices are snippet-relative and would
   * read as (wrong) file line numbers if shown.
   */
  readonly lineNumbers?: false
}

function padNum(n: number | undefined, width: number): string {
  return n === undefined ? " ".repeat(width) : String(n).padStart(width, " ")
}

export function renderDiff(
  oldText: string,
  newText: string,
  width: number,
  opts: DiffRenderOptions = {},
): DiffLine[] {
  let rows = numberRows(diffLines(oldText, newText))
  if (opts.contextLines !== undefined) {
    rows = collapseContext(rows, opts.contextLines)
  }

  const showNumbers = opts.lineNumbers !== false

  // Right-align both columns to the widest line number that actually appears,
  // so a 3-digit file does not waste columns a 1000-line file would need.
  const maxOldNum = rows.reduce((max, row) => Math.max(max, row.oldNum ?? 0), 0)
  const maxNewNum = rows.reduce((max, row) => Math.max(max, row.newNum ?? 0), 0)
  const numWidth = Math.max(
    1,
    String(maxOldNum).length,
    String(maxNewNum).length,
  )
  const numColWidth = showNumbers ? numWidth * 2 + 2 : 0 // "<old> <new> "

  const lines: DiffLine[] = []
  const bodyWidth = Math.max(1, width - numColWidth - 2)
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!
    const numCol =
      row.collapsed === true
        ? " ".repeat(numColWidth)
        : `${padNum(row.oldNum, numWidth)} ${padNum(row.newNum, numWidth)} `
    const sign = GUTTER[row.kind]
    const paired =
      row.kind === "del" && rows[r + 1]?.kind === "add"
        ? rows[r + 1]!.text
        : row.kind === "add" && rows[r - 1]?.kind === "del"
          ? rows[r - 1]!.text
          : undefined
    const segFg = rowColor(row.kind)
    const bodySegs: DiffSegment[] =
      (row.kind === "add" || row.kind === "del") &&
      paired !== undefined &&
      paired !== row.text
        ? wordDiffSegments(row.text, row.kind, paired)
        : [{ text: row.text, fg: segFg }]

    const ranges =
      row.text.length === 0
        ? [{ start: 0, end: 0 }]
        : wrapRanges(row.text, bodyWidth)
    for (let idx = 0; idx < ranges.length; idx++) {
      const range = ranges[idx]!
      const piece = sliceSegments(bodySegs, range.start, range.end)
      lines.push([
        ...(showNumbers
          ? [
              {
                text: idx === 0 ? numCol : " ".repeat(numColWidth),
                fg: DIFF_FG.context,
              },
            ]
          : []),
        { text: idx === 0 ? sign : "  ", fg: segFg },
        ...(piece.length > 0 ? piece : [{ text: "", fg: segFg }]),
      ])
    }
  }
  return lines
}

type EditArgs = {
  path?: unknown
  old_string?: unknown
  new_string?: unknown
  content?: unknown
}

export type EditDiffSource = {
  readonly oldText: string
  readonly newText: string
  readonly path?: string
}

/** Tools whose arguments carry the before/after text of a file edit. */
export function isEditToolName(toolName: string): boolean {
  return toolName === "edit_file" || toolName === "write_file"
}

/**
 * Pulls the before/after text out of an edit_file or write_file call's JSON
 * arguments. write_file carries only the new content, so its "before" is empty
 * and the whole file reads as an addition. Returns null for any other tool or
 * unparseable arguments.
 */
export function editDiffFromArgs(
  toolName: string,
  rawArgs: string,
): EditDiffSource | null {
  if (!isEditToolName(toolName)) return null
  let parsed: EditArgs
  try {
    parsed = JSON.parse(rawArgs) as EditArgs
  } catch {
    return null
  }
  const path = typeof parsed.path === "string" ? parsed.path : undefined
  if (toolName === "write_file") {
    if (typeof parsed.content !== "string") return null
    return {
      oldText: "",
      newText: parsed.content,
      ...(path !== undefined ? { path } : {}),
    }
  }
  if (
    typeof parsed.old_string !== "string" ||
    typeof parsed.new_string !== "string"
  ) {
    return null
  }
  return {
    oldText: parsed.old_string,
    newText: parsed.new_string,
    ...(path !== undefined ? { path } : {}),
  }
}

/** Body width assumed for a transcript diff; wide enough for typical code. */
export const DIFF_BODY_WIDTH = 100

/**
 * Cap on painted diff lines. Edit hunks are small, but a whole-file write
 * diffs against an empty side and would otherwise flood the transcript.
 */
const MAX_DIFF_LINES = 60

/**
 * Build the diff view for a tool call's arguments, or null when the tool is not
 * an edit tool or its arguments do not carry both sides.
 */
export function editDiffView(
  toolName: string,
  rawArgs: string,
  width: number = DIFF_BODY_WIDTH,
): DiffView | null {
  const source = editDiffFromArgs(toolName, rawArgs)
  if (source === null) return null
  const { added, removed } = diffStat(source.oldText, source.newText)
  if (added === 0 && removed === 0) return null
  // Snippet-relative row indices would read as (wrong) file line numbers.
  const all = renderDiff(source.oldText, source.newText, width, {
    lineNumbers: false,
  })
  const lines =
    all.length > MAX_DIFF_LINES
      ? [
          ...all.slice(0, MAX_DIFF_LINES),
          [
            {
              text: `… ${all.length - MAX_DIFF_LINES} more diff lines`,
              fg: DIFF_FG.context,
            },
          ],
        ]
      : all
  return {
    lines,
    added,
    removed,
    ...(source.path !== undefined ? { path: source.path } : {}),
  }
}

/** Uncoloured diff body, for the clipboard. */
export function diffPlainText(view: DiffView): string {
  return view.lines
    .map((line) => line.map((segment) => segment.text).join(""))
    .join("\n")
}

export type ToolCallRowInput = {
  readonly name: string
  /** Raw JSON arguments as streamed by the model; may be absent or partial. */
  readonly arguments?: string
}

/**
 * Build the transcript row for a tool call: a diff view when the call is a
 * file edit, otherwise a human summary of the arguments with the structured
 * form behind the expand key. Raw argument JSON stays on the row as `text` —
 * it is what the clipboard and any un-summarisable call still need — but it
 * is not what the transcript paints.
 *
 * `verb` + `summary` read as a sentence ("Read path", "Shell command"): the
 * verb comes from `describeToolCall`'s existing tool-name-to-display mapping
 * rather than re-deriving one, and the subject is its argument summary (the
 * command itself for a shell call, the path for a file tool).
 */
export function toolCallRow(input: ToolCallRowInput): StreamRow {
  const args = input.arguments ?? ""
  const diff = args.length > 0 ? editDiffView(input.name, args) : null
  const text = args.length > 0 ? args : "…"
  const meta =
    diff !== null
      ? [input.name, diff.path, `+${diff.added}/-${diff.removed}`]
          .filter((part) => part !== undefined && part.length > 0)
          .join(" ")
      : input.name
  const call = args.length > 0 ? describeToolCall(input.name, args) : null
  const summarised = diff === null && args.length > 0 ? toolArgsView(input.name, args) : null
  // `summarised` (view/JSON-aware) wins when it has an opinion — it is what the
  // existing collapse mechanism already renders for a view spec or a wide
  // argument object. `call.summary` only fills the gap it leaves: a short
  // literal call (e.g. a one-line shell command) that toolArgsView leaves
  // alone because it already reads fine, but which still needs a subject to
  // pair with its verb.
  const summary = diff !== null
    ? (diff.path ?? summarised?.summary ?? call?.summary)
    : (summarised?.summary ?? call?.summary)
  const stat = diff !== null ? `+${diff.added}/-${diff.removed}` : undefined
  const detail = summarised?.detail
  const verb = call?.display
  // Identity of the sentence this call paints, not of its arguments: two calls
  // that read the same line are what a repeat looks like to the operator.
  const callKey = `${input.name} ${verb ?? ""} ${summary ?? ""}`
  return {
    role: "tool",
    text,
    meta,
    pending: true,
    callKey,
    ...(diff !== null ? { diff } : {}),
    ...(verb !== undefined ? { verb } : {}),
    // A summarised call may deliberately have no subject — its verb already
    // names the whole call — and that blank must survive, or the row falls
    // back to painting the raw arguments.
    ...(summary !== undefined && (summary.length > 0 || summarised !== null)
      ? { summary }
      : {}),
    ...(stat !== undefined ? { stat } : {}),
    ...(detail !== undefined && detail.length > 0 ? { detail } : {}),
  }
}
