import type { StyledLine } from "./view/index.js";
import type { StyledSegment } from "./markdown-parser.js";
import { wrapRanges } from "./view/height.js";
import { color } from "./theme.js";

export type DiffRowKind = "add" | "del" | "context";
export type DiffRow = { kind: DiffRowKind; text: string };

// A row plus its position in the old/new file. `collapsed` marks the "N
// unchanged lines" summary row inserted by collapseContext, which occupies no
// real line in either file and so carries no line numbers.
type NumberedRow = DiffRow & { oldNum?: number; newNum?: number; collapsed?: boolean };

// Longest-common-subsequence line diff. The classic dynamic-programming table
// is fine here: edit hunks (old_string vs new_string) are small, and even a
// whole-file write diffs against an empty side, so the quadratic cost never
// bites in practice.
export function diffLines(oldText: string, newText: string): DiffRow[] {
  const a = oldText.length === 0 ? [] : oldText.split("\n");
  const b = newText.length === 0 ? [] : newText.split("\n");
  const n = a.length;
  const m = b.length;

  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ kind: "context", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      rows.push({ kind: "del", text: a[i]! });
      i++;
    } else {
      rows.push({ kind: "add", text: b[j]! });
      j++;
    }
  }
  while (i < n) rows.push({ kind: "del", text: a[i++]! });
  while (j < m) rows.push({ kind: "add", text: b[j++]! });
  return rows;
}

const GUTTER: Record<DiffRowKind, string> = { add: "+ ", del: "- ", context: "  " };

function rowColor(kind: DiffRowKind): string {
  if (kind === "add") return color("diffAdded");
  if (kind === "del") return color("diffRemoved");
  return color("diffContext");
}

// Attach each row's position in the old/new file before any collapsing, so a
// hidden stretch still leaves the surviving rows numbered correctly.
function numberRows(rows: DiffRow[]): NumberedRow[] {
  let oldLine = 1;
  let newLine = 1;
  return rows.map((row) => {
    if (row.kind === "context") return { ...row, oldNum: oldLine++, newNum: newLine++ };
    if (row.kind === "del") return { ...row, oldNum: oldLine++ };
    return { ...row, newNum: newLine++ };
  });
}

// Collapse long unchanged stretches to a few lines of context on each side of a
// change so a large file write or a wide edit does not bury the actual delta.
function collapseContext(rows: NumberedRow[], pad: number): NumberedRow[] {
  const keep = new Array<boolean>(rows.length).fill(false);
  rows.forEach((row, idx) => {
    if (row.kind === "context") return;
    for (let k = Math.max(0, idx - pad); k <= Math.min(rows.length - 1, idx + pad); k++) keep[k] = true;
  });

  const out: NumberedRow[] = [];
  let hidden = 0;
  const flush = (): void => {
    if (hidden > 0) {
      out.push({ kind: "context", text: `… ${hidden} unchanged line${hidden === 1 ? "" : "s"}`, collapsed: true });
      hidden = 0;
    }
  };
  rows.forEach((row, idx) => {
    if (keep[idx]) {
      flush();
      out.push(row);
    } else {
      hidden++;
    }
  });
  flush();
  return out;
}

export type DiffRenderOptions = {
  // Lines of unchanged context to keep around each change. Undefined keeps the
  // diff uncollapsed (the right call for the small localized edit hunks).
  contextLines?: number;
  // Hide the old/new line-number gutter. edit_file hunks diff old_string
  // against new_string, so their row indices are snippet-relative and would
  // read as (wrong) file line numbers if shown.
  lineNumbers?: false;
};

function tokenizeWords(line: string): string[] {
  return line.match(/\S+|\s+/g) ?? (line.length === 0 ? [] : [line]);
}

function lcsTable(a: string[], b: string[]): number[][] {
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  return table;
}

// Token LCS over words/whitespace runs so a rename or argument swap only paints
// the changed tokens, not the whole line. Emits segments for `line` only (the
// side being rendered); tokens unique to `paired` are skipped on this pass.
export function wordDiffSegments(line: string, kind: "add" | "del", paired: string): StyledSegment[] {
  const self = tokenizeWords(line);
  const other = tokenizeWords(paired);
  if (self.length === 0) return [{ text: line, color: rowColor(kind) }];

  const lcs = lcsTable(self, other);
  const out: StyledSegment[] = [];
  let i = 0;
  let j = 0;
  const n = self.length;
  const m = other.length;
  while (i < n && j < m) {
    if (self[i] === other[j]) {
      out.push({ text: self[i]!, color: color("diffContext") });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ text: self[i]!, color: rowColor(kind) });
      i++;
    } else {
      j++;
    }
  }
  while (i < n) out.push({ text: self[i++]!, color: rowColor(kind) });
  return out.length > 0 ? out : [{ text: line, color: rowColor(kind) }];
}

function sliceSegments(segments: StyledSegment[], start: number, end: number): StyledSegment[] {
  const out: StyledSegment[] = [];
  let pos = 0;
  for (const seg of segments) {
    const segStart = pos;
    const segEnd = pos + seg.text.length;
    pos = segEnd;
    const from = Math.max(start, segStart);
    const to = Math.min(end, segEnd);
    if (to > from) out.push({ ...seg, text: seg.text.slice(from - segStart, to - segStart) });
  }
  return out;
}

function padNum(n: number | undefined, width: number): string {
  return n === undefined ? " ".repeat(width) : String(n).padStart(width, " ");
}

export function renderDiff(oldText: string, newText: string, width: number, opts: DiffRenderOptions = {}): StyledLine[] {
  let rows = numberRows(diffLines(oldText, newText));
  if (opts.contextLines !== undefined) rows = collapseContext(rows, opts.contextLines);

  const showNumbers = opts.lineNumbers !== false;

  // Right-align both columns to the widest line number that actually appears,
  // so a 3-digit file doesn't waste columns a 1000-line file would need.
  const maxOldNum = rows.reduce((max, row) => Math.max(max, row.oldNum ?? 0), 0);
  const maxNewNum = rows.reduce((max, row) => Math.max(max, row.newNum ?? 0), 0);
  const numWidth = Math.max(1, String(maxOldNum).length, String(maxNewNum).length);
  const numColWidth = showNumbers ? numWidth * 2 + 2 : 0; // "<old> <new> "
  const numColor = color("diffContext");

  const lines: StyledLine[] = [];
  const bodyWidth = Math.max(1, width - numColWidth - 2);
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    const numCol = row.collapsed === true ? " ".repeat(numColWidth) : `${padNum(row.oldNum, numWidth)} ${padNum(row.newNum, numWidth)} `;
    const sign = GUTTER[row.kind];
    const paired =
      row.kind === "del" && rows[r + 1]?.kind === "add" ? rows[r + 1]!.text
      : row.kind === "add" && rows[r - 1]?.kind === "del" ? rows[r - 1]!.text
      : undefined;
    const segColor = rowColor(row.kind);
    let bodySegs: StyledSegment[];
    if ((row.kind === "add" || row.kind === "del") && paired !== undefined && paired !== row.text) {
      bodySegs = wordDiffSegments(row.text, row.kind, paired);
    } else {
      bodySegs = [{ text: row.text, color: segColor }];
    }
    const ranges = row.text.length === 0 ? [{ start: 0, end: 0 }] : wrapRanges(row.text, bodyWidth);
    for (let idx = 0; idx < ranges.length; idx++) {
      const range = ranges[idx]!;
      const piece = sliceSegments(bodySegs, range.start, range.end);
      lines.push([
        ...(showNumbers ? [{ text: idx === 0 ? numCol : " ".repeat(numColWidth), color: numColor }] : []),
        { text: idx === 0 ? sign : "  ", color: segColor },
        ...(piece.length > 0 ? piece : [{ text: "", color: segColor }]),
      ]);
    }
  }
  return lines;
}

export function diffStat(oldText: string, newText: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const row of diffLines(oldText, newText)) {
    if (row.kind === "add") added++;
    else if (row.kind === "del") removed++;
  }
  return { added, removed };
}

type EditArgs = { path?: unknown; old_string?: unknown; new_string?: unknown; content?: unknown };

// Pulls the before/after text out of an edit_file or write_file call's JSON
// arguments. write_file carries only the new content, so its "before" is empty
// and the whole file reads as an addition. Returns null for any other tool or
// unparseable arguments.
export function editDiffFromArgs(toolName: string, rawArgs: string): { oldText: string; newText: string; path?: string } | null {
  if (toolName !== "edit_file" && toolName !== "write_file") return null;
  let parsed: EditArgs;
  try {
    parsed = JSON.parse(rawArgs) as EditArgs;
  } catch {
    return null;
  }
  const path = typeof parsed.path === "string" ? parsed.path : undefined;
  if (toolName === "write_file") {
    if (typeof parsed.content !== "string") return null;
    return { oldText: "", newText: parsed.content, ...(path !== undefined ? { path } : {}) };
  }
  if (typeof parsed.old_string !== "string" || typeof parsed.new_string !== "string") return null;
  return { oldText: parsed.old_string, newText: parsed.new_string, ...(path !== undefined ? { path } : {}) };
}
