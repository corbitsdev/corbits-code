import { type ViewNode, VIEW_TABLE_MAX_ROWS } from "./spec.js";

const LINE_PADDING = 2;

export type RowRange = { start: number; end: number };

// Greedy word-wrap for a single logical line (no embedded newlines). Returns the
// character ranges each visual row occupies, end-exclusive, with the space that a
// soft break lands on consumed (excluded from both rows) — exactly how a terminal
// soft-wraps. A word longer than the width hard-breaks by character so no content
// is lost. This is the single source of truth for wrapping: the event log slices
// content by these ranges and renders one Text per row with no further wrapping,
// so the painted row count is authoritative rather than an estimate that can
// diverge from what Ink draws.
export function wrapRanges(line: string, width: number): RowRange[] {
  const w = Math.max(1, width);
  if (line.length <= w) return [{ start: 0, end: line.length }];

  const ranges: RowRange[] = [];
  let pos = 0;
  while (line.length - pos > w) {
    const windowEnd = pos + w;
    let breakAt = -1;
    for (let i = windowEnd; i > pos; i--) {
      if (/\s/.test(line[i]!)) {
        breakAt = i;
        break;
      }
    }
    if (breakAt <= pos) {
      ranges.push({ start: pos, end: windowEnd });
      pos = windowEnd;
    } else {
      ranges.push({ start: pos, end: breakAt });
      pos = breakAt + 1;
    }
  }
  ranges.push({ start: pos, end: line.length });
  return ranges;
}

// Wrap a logical line into the visual rows it occupies, preserving every
// character (indentation, internal spacing) except the single space a soft break
// consumes.
export function wrapLines(line: string, width: number): string[] {
  return wrapRanges(line, width).map((r) => line.slice(r.start, r.end));
}

export function wrapCount(text: string, width: number): number {
  const w = Math.max(1, width);
  return text.split("\n").reduce((n, line) => n + wrapRanges(line, w).length, 0);
}

export function viewHeight(node: ViewNode, columns: number): number {
  const width = Math.max(8, columns - LINE_PADDING);
  switch (node.type) {
    case "divider":
    case "badge":
    case "progress":
      return 1;
    case "text":
    case "heading":
      return wrapCount(node.value, width);
    case "keyValue":
      return Math.max(1, node.pairs.length);
    case "list":
      return Math.max(1, node.items.length);
    case "table": {
      const shown = Math.min(node.rows.length, VIEW_TABLE_MAX_ROWS);
      return 1 + shown + (node.rows.length > shown ? 1 : 0);
    }
    case "card": {
      const title = node.title !== undefined ? 1 : 0;
      const subtitle = node.subtitle !== undefined ? 1 : 0;
      const badges = node.badges !== undefined && node.badges.length > 0 ? 1 : 0;
      return Math.max(1, title + subtitle + node.fields.length + badges);
    }
    case "stack": {
      const sum = node.children.reduce((n, c) => n + viewHeight(c, columns), 0);
      const gaps = (node.gap ?? 0) > 0 && node.children.length > 1 ? node.children.length - 1 : 0;
      return Math.max(1, sum + gaps);
    }
  }
}
