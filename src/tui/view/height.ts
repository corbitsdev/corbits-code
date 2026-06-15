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
