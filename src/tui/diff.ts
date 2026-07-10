import type { StyledLine } from "./view/index.js";
import type { StyledSegment } from "./markdown-parser.js";
import { wrapLines } from "./view/height.js";
import { color } from "./theme.js";

export type DiffRowKind = "add" | "del" | "context";
export type DiffRow = { kind: DiffRowKind; text: string };

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

// Collapse long unchanged stretches to a few lines of context on each side of a
// change so a large file write or a wide edit does not bury the actual delta.
function collapseContext(rows: DiffRow[], pad: number): DiffRow[] {
  const keep = new Array<boolean>(rows.length).fill(false);
  rows.forEach((row, idx) => {
    if (row.kind === "context") return;
    for (let k = Math.max(0, idx - pad); k <= Math.min(rows.length - 1, idx + pad); k++) keep[k] = true;
  });

  const out: DiffRow[] = [];
  let hidden = 0;
  const flush = (): void => {
    if (hidden > 0) {
      out.push({ kind: "context", text: `… ${hidden} unchanged line${hidden === 1 ? "" : "s"}` });
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
};

function tokenizeWords(line: string): string[] {
  return line.match(/\S+|\s+/g) ?? (line.length === 0 ? [] : [line]);
}

function wordDiffSegments(line: string, kind: "add" | "del", paired: string): StyledSegment[] {
  const a = tokenizeWords(line);
  const b = tokenizeWords(paired);
  const n = Math.max(a.length, b.length);
  const out: StyledSegment[] = [];
  for (let i = 0; i < n; i++) {
    const ta = a[i] ?? "";
    const tb = b[i] ?? "";
    const token = kind === "del" ? ta : tb;
    if (token.length === 0) continue;
    const same = ta === tb && ta.length > 0;
    out.push({
      text: token,
      color: same ? color("diffContext") : rowColor(kind),
    });
  }
  return out.length > 0 ? out : [{ text: line, color: rowColor(kind) }];
}

export function renderDiff(oldText: string, newText: string, width: number, opts: DiffRenderOptions = {}): StyledLine[] {
  let rows = diffLines(oldText, newText);
  if (opts.contextLines !== undefined) rows = collapseContext(rows, opts.contextLines);

  const lines: StyledLine[] = [];
  const bodyWidth = Math.max(1, width - 2);
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    const gutter = GUTTER[row.kind];
    const paired =
      row.kind === "del" && rows[r + 1]?.kind === "add" ? rows[r + 1]!.text
      : row.kind === "add" && rows[r - 1]?.kind === "del" ? rows[r - 1]!.text
      : undefined;
    const useWords = (row.kind === "add" || row.kind === "del") && paired !== undefined && paired !== row.text;
    const segColor = rowColor(row.kind);
    const wrapped = row.text.length === 0 ? [""] : wrapLines(row.text, bodyWidth);
    wrapped.forEach((piece, idx) => {
      const bodySegs = useWords && idx === 0
        ? wordDiffSegments(piece, row.kind as "add" | "del", paired!)
        : [{ text: piece, color: segColor }];
      lines.push([
        { text: idx === 0 ? gutter : "  ", color: segColor },
        ...bodySegs,
      ]);
    });
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
