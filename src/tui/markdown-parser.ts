import { wrapRanges } from "./view/height.js";

export type StyledSegment = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strikethrough?: boolean;
  link?: boolean;
  heading?: number;
  bullet?: boolean;
  blockquote?: boolean;
  rule?: boolean;
  color?: string;
  dim?: boolean;
  backgroundColor?: string;
};

// Inline-markdown matchers. Hoisted to module scope so they are not re-created
// per loop iteration. All are anchored and stateless (no /g, /y) — safe to share.
const BOLD_RE = /^\*\*(.+?)\*\*|^__(.+?)__/;
const STRIKE_RE = /^~~(.+?)~~/;
const STAR_ITALIC_RE = /^(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/;
const UNDERSCORE_ITALIC_RE = /^_(?!_)(.+?)_(?!_)/;
const WORD_CHAR_RE = /[a-zA-Z0-9_]/;
const CODE_RE = /^`(.+?)`/;
const LINK_RE = /^\[([^\]]+)\]\(([^)]*(?:\([^)]*\))?[^)]*)\)/;
const PLAIN_RE = /^[^*_`~[]+/;

function parseSegments(text: string): StyledSegment[] {
  const segments: StyledSegment[] = [];
  let remaining = text;
  let offset = 0;

  while (remaining.length > 0) {
    // Bold: **text** or __text__
    const boldMatch = remaining.match(BOLD_RE);
    if (boldMatch) {
      const content = boldMatch[1] || boldMatch[2] || "";
      if (content) {
        segments.push({ text: content, bold: true });
        remaining = remaining.slice(boldMatch[0].length);
        offset += boldMatch[0].length;
        continue;
      }
    }

    // Strikethrough: ~~text~~
    const strikeMatch = remaining.match(STRIKE_RE);
    if (strikeMatch && strikeMatch[1]) {
      segments.push({ text: strikeMatch[1], strikethrough: true });
      remaining = remaining.slice(strikeMatch[0].length);
      offset += strikeMatch[0].length;
      continue;
    }

    // Italic: *text* or _text_ (but not ** or __)
    // For _, enforce word boundaries: must open after start/whitespace/punctuation
    // and close before end/whitespace/punctuation. For *, intraword is allowed.
    const starMatch = remaining.match(STAR_ITALIC_RE);
    if (starMatch && starMatch[1]) {
      segments.push({ text: starMatch[1], italic: true });
      remaining = remaining.slice(starMatch[0].length);
      offset += starMatch[0].length;
      continue;
    }

    // Underscore italic with word-boundary enforcement.
    // Underscore can only open italic if the previous char (in original text) is
    // not a word character, or we're at the start of the string.
    if (remaining[0] === "_" && remaining[1] !== "_") {
      const prevChar = offset > 0 ? text[offset - 1] : null;
      const isPrecededByNonWord = !prevChar || !WORD_CHAR_RE.test(prevChar);

      if (isPrecededByNonWord) {
        const closeMatch = remaining.match(UNDERSCORE_ITALIC_RE);
        if (closeMatch && closeMatch[1]) {
          segments.push({ text: closeMatch[1], italic: true });
          remaining = remaining.slice(closeMatch[0].length);
          offset += closeMatch[0].length;
          continue;
        }
      }
    }

    // Inline code: `text`
    const codeMatch = remaining.match(CODE_RE);
    if (codeMatch && codeMatch[1]) {
      segments.push({ text: codeMatch[1], code: true });
      remaining = remaining.slice(codeMatch[0].length);
      offset += codeMatch[0].length;
      continue;
    }

    // Link: [text](url) — show the text, then the url in parentheses if short.
    // For URLs with balanced parens (e.g., fn(arg)), try to match a single level
    // of nesting. If URL is long (> 40 chars), omit the URL from output.
    const linkMatch = remaining.match(LINK_RE);
    if (linkMatch && linkMatch[1] !== undefined && linkMatch[2] !== undefined) {
      const text = linkMatch[1];
      const url = linkMatch[2];
      segments.push({ text, link: true });
      // Show the URL only when it is present and short enough to be useful;
      // an empty URL ([text]()) still renders as a styled link, not raw text.
      if (url.length > 0 && url.length <= 40) {
        segments.push({ text: ` (${url})` });
      }
      remaining = remaining.slice(linkMatch[0].length);
      offset += linkMatch[0].length;
      continue;
    }

    // Plain text up to the next possible marker.
    const plainMatch = remaining.match(PLAIN_RE);
    if (plainMatch && plainMatch[0]) {
      segments.push({ text: plainMatch[0] });
      remaining = remaining.slice(plainMatch[0].length);
      offset += plainMatch[0].length;
      continue;
    }

    // A marker character that did not start a token (e.g. a lone `[`): emit it
    // as plain text and move on.
    segments.push({ text: remaining[0]! });
    remaining = remaining.slice(1);
    offset += 1;
  }

  return segments;
}

function applyFlag(segments: StyledSegment[], flag: Partial<StyledSegment>): StyledSegment[] {
  return segments.map((seg) => ({ ...seg, ...flag }));
}

const RULE_GLYPH = "─".repeat(24);

function parseLine(line: string): StyledSegment[] {
  // Horizontal rule: a line of three or more -, * or _.
  if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
    return [{ text: RULE_GLYPH, rule: true }];
  }

  // Headings h1–h6. The marker is stripped; inline markdown still applies.
  const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
  if (headingMatch) {
    const level = headingMatch[1]!.length;
    return applyFlag(parseSegments(headingMatch[2] || ""), { heading: level });
  }

  // Blockquote: > text. Rendered with a bar glyph; inline markdown still applies.
  const quoteMatch = line.match(/^\s*>\s?(.*)$/);
  if (quoteMatch) {
    const marker: StyledSegment = { text: "│ ", blockquote: true };
    return [marker, ...applyFlag(parseSegments(quoteMatch[1] || ""), { blockquote: true })];
  }

  // Ordered list: optional indent, then "1." or "1)" then content. The number
  // is kept; inline markdown in the content still applies.
  const orderedMatch = line.match(/^(\s*)(\d+)[.)]\s+(.+)$/);
  if (orderedMatch) {
    const marker: StyledSegment = { text: `${orderedMatch[1]}${orderedMatch[2]}. `, bullet: true };
    return [marker, ...applyFlag(parseSegments(orderedMatch[3] || ""), { bullet: true })];
  }

  // Unordered list: optional indent, then - or * marker. The raw marker becomes
  // a "• " glyph; inline markdown in the content still applies.
  const listMatch = line.match(/^(\s*)[-*]\s+(.+)$/);
  if (listMatch) {
    const marker: StyledSegment = { text: (listMatch[1] || "") + "• ", bullet: true };
    return [marker, ...applyFlag(parseSegments(listMatch[2] || ""), { bullet: true })];
  }

  return parseSegments(line);
}

// `width` is the column budget the rendered output must fit within (the same
// width the event log wraps to). Tables use it to decide their layout; default
// Infinity lays them out at natural width.
export function parseMarkdown(text: string, width = Infinity): StyledSegment[][] {
  const lines: StyledSegment[][] = [];
  let inFence = false;
  const input = text.split("\n");

  for (let i = 0; i < input.length; i++) {
    const line = input[i]!;

    // Fenced code block delimiters (``` or ~~~). The delimiter line itself is
    // rendered as a blank separator; lines inside are shown verbatim as code
    // with no inline parsing.
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      lines.push([]);
      continue;
    }
    if (inFence) {
      lines.push(line.length === 0 ? [] : [{ text: line, code: true }]);
      continue;
    }

    const table = parseTableBlock(input, i, width);
    if (table !== null) {
      lines.push(...table.lines);
      i += table.consumed - 1;
      continue;
    }

    lines.push(parseLine(line));
  }

  return lines;
}

type ParsedTable = {
  lines: StyledSegment[][];
  consumed: number;
};

const TABLE_SEP = " | ";
const MIN_COL_WIDTH = 6;

function renderedLength(segments: StyledSegment[]): number {
  return segments.reduce((sum, seg) => sum + seg.text.length, 0);
}

// Slice a styled cell's segments to the character range [start, end), preserving
// each surviving segment's styling, so a cell that wraps across visual rows keeps
// its inline markdown.
function sliceCellSegments(segments: StyledSegment[], start: number, end: number): StyledSegment[] {
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

function padCell(segments: StyledSegment[], width: number): StyledSegment[] {
  const gap = width - renderedLength(segments);
  return gap > 0 ? [...segments, { text: " ".repeat(gap) }] : segments;
}

function parseTableBlock(lines: string[], startIndex: number, width: number): ParsedTable | null {
  const header = lines[startIndex];
  const separator = lines[startIndex + 1];
  if (header === undefined || separator === undefined) return null;
  if (!isTableRow(header) || !isTableSeparator(separator)) return null;

  const rawRows: string[][] = [extractTableCells(header)];
  let consumed = 2;

  for (let i = startIndex + 2; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || !isTableRow(line)) break;
    rawRows.push(extractTableCells(line));
    consumed++;
  }

  const cols = Math.max(...rawRows.map((row) => row.length));
  // Parse each cell's inline markdown up front so column widths reflect the
  // rendered text (markers stripped), not the raw source.
  const cells: StyledSegment[][][] = rawRows.map((row) =>
    Array.from({ length: cols }, (_, col) => parseSegments(row[col] ?? "")),
  );
  const naturalWidths = Array.from({ length: cols }, (_, col) =>
    Math.max(...cells.map((row) => renderedLength(row[col] ?? []))),
  );

  const sepTotal = TABLE_SEP.length * (cols - 1);
  const naturalWidth = naturalWidths.reduce((a, b) => a + b, 0) + sepTotal;

  if (!Number.isFinite(width) || naturalWidth <= width) {
    return { lines: renderGrid(cells, naturalWidths), consumed };
  }

  const targetContent = width - sepTotal;
  if (targetContent < cols * MIN_COL_WIDTH) {
    return { lines: renderKeyValue(cells), consumed };
  }

  return { lines: renderGrid(cells, fitColumnWidths(naturalWidths, targetContent)), consumed };
}

// Shrink columns proportionally to their natural width so the row fits the
// budget, never below MIN_COL_WIDTH and never wider than the content needs.
function fitColumnWidths(naturalWidths: number[], targetContent: number): number[] {
  const sumNatural = naturalWidths.reduce((a, b) => a + b, 0) || 1;
  const widths = naturalWidths.map((natural) =>
    Math.min(natural, Math.max(MIN_COL_WIDTH, Math.floor((natural / sumNatural) * targetContent))),
  );

  let overflow = widths.reduce((a, b) => a + b, 0) - targetContent;
  while (overflow > 0) {
    let widest = -1;
    for (let col = 0; col < widths.length; col++) {
      if ((widths[col] ?? 0) > MIN_COL_WIDTH && (widest < 0 || (widths[col] ?? 0) > (widths[widest] ?? 0))) {
        widest = col;
      }
    }
    if (widest < 0) break;
    widths[widest]!--;
    overflow--;
  }

  return widths;
}

// Lay cells into an aligned grid, wrapping each cell to its column width and
// stacking the wrapped lines so columns stay aligned across visual rows.
function renderGrid(cells: StyledSegment[][][], colWidths: number[]): StyledSegment[][] {
  const out: StyledSegment[][] = [];

  for (const row of cells) {
    const wrapped = row.map((cell, col) => {
      const colWidth = colWidths[col] ?? 0;
      const text = cell.map((s) => s.text).join("");
      return wrapRanges(text, colWidth).map((range) =>
        padCell(sliceCellSegments(cell, range.start, range.end), colWidth),
      );
    });

    const height = Math.max(1, ...wrapped.map((lines) => lines.length));
    for (let r = 0; r < height; r++) {
      const line: StyledSegment[] = [];
      for (let col = 0; col < colWidths.length; col++) {
        const colWidth = colWidths[col] ?? 0;
        const cellLine = wrapped[col]?.[r] ?? [{ text: " ".repeat(colWidth) }];
        line.push(...cellLine);
        if (col < colWidths.length - 1) line.push({ text: TABLE_SEP });
      }
      out.push(line);
    }
  }

  return out;
}

// Fallback for tables too wide to shrink: stack each data row as "Header: value"
// lines, with the header keys in bold and a blank line between rows. Each line is
// left for the event log to wrap as ordinary text.
function renderKeyValue(cells: StyledSegment[][][]): StyledSegment[][] {
  const [headers, ...dataRows] = cells;
  if (headers === undefined) return [];

  const out: StyledSegment[][] = [];
  dataRows.forEach((row, ri) => {
    if (ri > 0) out.push([]);
    for (let col = 0; col < headers.length; col++) {
      const key = applyFlag(headers[col] ?? [], { bold: true });
      out.push([...key, { text: ": " }, ...(row[col] ?? [])]);
    }
  });

  return out;
}

function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line);
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?(?:\s*:?-{1,}:?\s*\|)+\s*:?-{1,}:?\s*\|?\s*$/.test(line);
}

function extractTableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");

  const cells: string[] = [];
  let cell = "";
  let i = 0;

  while (i < trimmed.length) {
    if (trimmed[i] === "\\" && trimmed[i + 1] === "|") {
      // An escaped pipe is literal cell content: render it as "|", not "\|".
      cell += "|";
      i += 2;
    } else if (trimmed[i] === "|") {
      cells.push(cell.trim());
      cell = "";
      i++;
    } else {
      cell += trimmed[i];
      i++;
    }
  }

  cells.push(cell.trim());

  return cells;
}
