export type RowRange = { start: number; end: number };

// Display width in terminal cells: emoji and CJK count as two columns, combining
// marks and control characters as zero. The wrap and pad math is in columns, not
// UTF-16 code units, so wide glyphs do not misalign tables or nudge the newest
// line off-screen.
export function stringWidth(text: string): number {
  return Bun.stringWidth(text);
}

const SURROGATE_RE = /[\uD800-\uDFFF]/;

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
  const displayWidth = stringWidth(line);
  if (displayWidth <= w) return [{ start: 0, end: line.length }];
  // Pure single-column text (no wide glyphs, no surrogate pairs) takes the code
  // unit path, where an index is a column — the common case and the one every
  // wrap test pins.
  if (displayWidth === line.length && !SURROGATE_RE.test(line)) return wrapNarrow(line, w);
  return wrapWide(line, w);
}

function wrapNarrow(line: string, w: number): RowRange[] {
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

// Column-aware wrap for lines that contain wide glyphs or surrogate pairs. Walks
// by code point so an emoji is never split, and breaks on the last whitespace
// that still fits the column budget, falling back to a hard break for a single
// word wider than the row.
function wrapWide(line: string, w: number): RowRange[] {
  const ranges: RowRange[] = [];
  let rowStart = 0;
  let rowWidth = 0;
  let lastSpace = -1;
  let i = 0;

  while (i < line.length) {
    const ch = String.fromCodePoint(line.codePointAt(i)!);
    const cw = stringWidth(ch);
    const isSpace = /\s/.test(ch);

    if (rowWidth + cw > w && i > rowStart) {
      if (isSpace) {
        // The overflowing character is itself whitespace, so it is the soft
        // break and is consumed rather than carried onto the next row.
        ranges.push({ start: rowStart, end: i });
        rowStart = i + ch.length;
      } else if (lastSpace > rowStart) {
        ranges.push({ start: rowStart, end: lastSpace });
        rowStart = lastSpace + 1;
      } else {
        ranges.push({ start: rowStart, end: i });
        rowStart = i;
      }
      rowWidth = stringWidth(line.slice(rowStart, i));
      lastSpace = -1;
      if (rowStart > i) i = rowStart;
      continue;
    }

    if (isSpace) lastSpace = i;
    rowWidth += cw;
    i += ch.length;
  }

  ranges.push({ start: rowStart, end: line.length });
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
