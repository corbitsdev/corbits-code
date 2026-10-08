import { highlightCode } from "./syntax-highlight.js";
import { wrapRanges, stringWidth } from "./view/height.js";

export interface StyledSegment {
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
  linkUrl?: string;
  codeFence?: boolean;
  // Start of a still-running tool call on the first segment of a pending tool
  // row; the event log animates those rows with a live spinner.
  toolRunningSince?: number;
}

// Inline-markdown matchers: anchored and stateless (no /g, /y), safe to share.
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

    // Italic: *text* or _text_ (not ** or __). `_` enforces word boundaries;
    // `*` allows intraword.
    const starMatch = remaining.match(STAR_ITALIC_RE);
    if (starMatch && starMatch[1]) {
      segments.push({ text: starMatch[1], italic: true });
      remaining = remaining.slice(starMatch[0].length);
      offset += starMatch[0].length;
      continue;
    }

    // `_` opens italic only after a non-word char or at string start.
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

    // Link: [text](url) — the text, plus the url in parens when short (≤ 40
    // chars; balanced-paren URLs match one level of nesting).
    const linkMatch = remaining.match(LINK_RE);
    if (linkMatch && linkMatch[1] !== undefined && linkMatch[2] !== undefined) {
      const text = linkMatch[1];
      const url = linkMatch[2];
      segments.push({
        text,
        link: true,
        ...(url.length > 0 ? { linkUrl: url } : {}),
      });
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

    // A marker that started no token (e.g. a lone `[`): emit it as plain text.
    const ch = remaining[0];
    if (ch == null) break;
    segments.push({ text: ch });
    remaining = remaining.slice(1);
    offset += 1;
  }

  return segments;
}

function applyFlag(
  segments: StyledSegment[],
  flag: Partial<StyledSegment>,
): StyledSegment[] {
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
    const hashes = headingMatch[1];
    if (hashes == null) throw new Error("heading marker missing");
    const level = hashes.length;
    return applyFlag(parseSegments(headingMatch[2] || ""), { heading: level });
  }

  // Blockquote: > text, rendered with a bar glyph; inline markdown applies.
  const quoteMatch = line.match(/^\s*>\s?(.*)$/);
  if (quoteMatch) {
    const marker: StyledSegment = { text: "│ ", blockquote: true };
    return [
      marker,
      ...applyFlag(parseSegments(quoteMatch[1] || ""), { blockquote: true }),
    ];
  }

  // Ordered list: optional indent, then "1." or "1)" then content; inline
  // markdown in the content still applies.
  const orderedMatch = line.match(/^(\s*)(\d+)[.)]\s+(.+)$/);
  if (orderedMatch) {
    const marker: StyledSegment = {
      text: `${orderedMatch[1]}${orderedMatch[2]}. `,
      bullet: true,
    };
    return [
      marker,
      ...applyFlag(parseSegments(orderedMatch[3] || ""), { bullet: true }),
    ];
  }

  // Unordered list: optional indent, then a - or * marker rendered as "• ";
  // inline markdown in the content still applies.
  const listMatch = line.match(/^(\s*)[-*]\s+(.+)$/);
  if (listMatch) {
    const marker: StyledSegment = {
      text: (listMatch[1] || "") + "• ",
      bullet: true,
    };
    return [
      marker,
      ...applyFlag(parseSegments(listMatch[2] || ""), { bullet: true }),
    ];
  }

  return parseSegments(line);
}

const FENCE_OPEN_RE = /^\s*(```+|~~~+)/;
const FENCE_CLOSE_RE = /^\s*(```+|~~~+)\s*$/;
// A partially-typed closing fence: zero to two lone fence chars on a line
// (zero = the empty line right after the body). Stripped from the streaming
// tail so the block does not flicker while the fence is typed.
const PARTIAL_FENCE_RE = /^\s*[`~]{0,2}\s*$/;
const INDENTED_CODE_RE = /^(?: {4}|\t)(.*)$/;
const CODE_GUTTER = "▏ ";

interface FencedBlock {
  lines: StyledSegment[][];
  consumed: number;
}

// Always paint the gutter, blank body lines included; skipping them split
// the bar into disconnected fragments.
function codeGutterPrefix(line: StyledSegment[]): StyledSegment[] {
  return [
    { text: CODE_GUTTER, code: true, dim: true, codeFence: true },
    ...line,
  ];
}

function fencedCap(label: string): StyledSegment[] {
  return [
    { text: "╭ ", dim: true, codeFence: true },
    { text: label, dim: true, codeFence: true },
  ];
}

function fencedFoot(): StyledSegment[] {
  return [{ text: "╰", dim: true, codeFence: true }];
}

// Collect a fenced block from `start`: highlight the body by the fence's
// language token and frame it with cap/gutter glyphs. An unclosed streaming
// block drops a partial closing fence so the tail re-highlights cleanly.
function parseFencedBlock(
  input: string[],
  start: number,
  width: number,
): FencedBlock {
  const openerLine = input[start];
  if (openerLine == null) throw new Error("fence opener missing");
  const language =
    openerLine.match(/^\s*(?:```+|~~~+)\s*([^\s`]*)/)?.[1] || undefined;
  const body: string[] = [];
  let i = start + 1;
  let closed = false;
  for (; i < input.length; i++) {
    const line = input[i];
    if (line == null) throw new Error("fence line missing");
    if (FENCE_CLOSE_RE.test(line)) {
      closed = true;
      break;
    }
    body.push(line);
  }
  const consumed = closed ? i - start + 1 : i - start;

  const last = body[body.length - 1];
  if (!closed && last != null && PARTIAL_FENCE_RE.test(last)) {
    body.pop();
  }

  const capLabel = language && language.length > 0 ? language : "code";
  const lines: StyledSegment[][] = [fencedCap(capLabel)];
  if (body.length > 0) {
    lines.push(
      ...highlightCode(body.join("\n"), language, width).map(codeGutterPrefix),
    );
  }
  if (closed) lines.push(fencedFoot());
  return { lines, consumed };
}

function parseIndentedCodeBlock(
  input: string[],
  start: number,
  width: number,
): FencedBlock {
  const body: string[] = [];
  let i = start;
  for (; i < input.length; i++) {
    const line = input[i];
    if (line == null) throw new Error("indented code line missing");
    const match = line.match(INDENTED_CODE_RE);
    if (!match) break;
    body.push(match[1] ?? "");
  }
  const lines: StyledSegment[][] = [fencedCap("code")];
  if (body.length > 0) {
    lines.push(
      ...highlightCode(body.join("\n"), undefined, width).map(codeGutterPrefix),
    );
  }
  lines.push(fencedFoot());
  return { lines, consumed: i - start };
}

export type MemoizedParseMarkdown = ((
  text: string,
  width?: number,
) => StyledSegment[][]) & {
  clear: () => void;
};

const DEFAULT_MARKDOWN_CACHE_ENTRIES = 32;

// Segments never change for a fixed (text, width) pair and resize-free
// re-renders re-ask for the same pair, so a small bounded LRU makes those
// hits. Callers clear() it with the per-block line cache (event-log.tsx /
// app.tsx) so it does not grow across a session.
export function createMemoizedParseMarkdown(
  maxEntries = DEFAULT_MARKDOWN_CACHE_ENTRIES,
): MemoizedParseMarkdown {
  const cache = new Map<string, StyledSegment[][]>();

  const memoized = (text: string, width = Infinity): StyledSegment[][] => {
    const key = `${width}\x1f${text}`;
    const cached = cache.get(key);
    if (cached !== undefined) {
      // Bump recency by re-inserting at the end of Map's iteration order.
      cache.delete(key);
      cache.set(key, cached);
      return cached;
    }

    const result = parseMarkdown(text, width);
    cache.set(key, result);
    if (cache.size > maxEntries) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) cache.delete(oldestKey);
    }
    return result;
  };

  memoized.clear = () => cache.clear();
  return memoized;
}

// `width` is the column budget the event log wraps to; tables lay out to it
// (default Infinity = natural width).
export function parseMarkdown(
  text: string,
  width = Infinity,
): StyledSegment[][] {
  const lines: StyledSegment[][] = [];
  const input = text.split("\n");

  for (let i = 0; i < input.length; i++) {
    const line = input[i];
    if (line == null) throw new Error("markdown line missing");

    // Fenced code block (``` or ~~~): collect it whole so the body can be
    // syntax-highlighted by the fence's language token.
    if (FENCE_OPEN_RE.test(line)) {
      const block = parseFencedBlock(input, i, width);
      lines.push(...block.lines);
      i += block.consumed - 1;
      continue;
    }

    if (INDENTED_CODE_RE.test(line)) {
      const block = parseIndentedCodeBlock(input, i, width);
      lines.push(...block.lines);
      i += block.consumed - 1;
      continue;
    }

    const table = parseTableBlock(input, i, width);
    if (table !== null) {
      lines.push(...table.lines);
      i += table.consumed - 1;
      continue;
    }

    const parsed = parseLine(line);
    // Air above a heading keeps sections distinct; skip when it opens the
    // message or already follows a blank line.
    if (parsed[0]?.heading !== undefined) {
      const last = lines[lines.length - 1];
      if (last !== undefined && last.length > 0) lines.push([]);
    }
    lines.push(parsed);
  }

  return lines;
}

interface ParsedTable {
  lines: StyledSegment[][];
  consumed: number;
}

// Internal separators only, matching opencode/Glamour: a unicode bar between
// columns and a dash header rule. No outer frame — width overhead, and
// neither reference TUI draws one.
const COL_SEP = "│";
const HEADER_RULE = "─";
const HEADER_CROSS = "┼";
const MIN_COL_WIDTH = 6;

// Each slot pads content to column width with one leading/trailing space;
// columns join by one bar, so overhead is a bar per gap plus two spaces.
function tableRowOverhead(cols: number): number {
  return cols - 1 + cols * 2;
}

function renderedLength(segments: StyledSegment[]): number {
  return segments.reduce((sum, seg) => sum + stringWidth(seg.text), 0);
}

function renderedText(segments: StyledSegment[]): string {
  return segments.map((seg) => seg.text).join("");
}

// Slice a styled cell's segments to [start, end), preserving each surviving
// segment's styling so a wrapped cell keeps its inline markdown.
function sliceCellSegments(
  segments: StyledSegment[],
  start: number,
  end: number,
): StyledSegment[] {
  const out: StyledSegment[] = [];
  let pos = 0;
  for (const seg of segments) {
    const segStart = pos;
    const segEnd = pos + seg.text.length;
    pos = segEnd;
    const from = Math.max(start, segStart);
    const to = Math.min(end, segEnd);
    if (to > from)
      out.push({
        ...seg,
        text: seg.text.slice(from - segStart, to - segStart),
      });
  }
  return out;
}

function padCell(segments: StyledSegment[], width: number): StyledSegment[] {
  const gap = width - renderedLength(segments);
  return gap > 0 ? [...segments, { text: " ".repeat(gap) }] : segments;
}

function parseTableBlock(
  lines: string[],
  startIndex: number,
  width: number,
): ParsedTable | null {
  const header = lines[startIndex];
  if (header === undefined || !looksLikeTableRow(header)) return null;

  const next = lines[startIndex + 1];
  const hasSeparator = next !== undefined && isTableSeparator(next);

  const rawRows: string[][] = [extractTableCells(header)];
  let consumed = hasSeparator ? 2 : 1;

  for (let i = startIndex + consumed; i < lines.length; i++) {
    const line = lines[i];
    if (
      line === undefined ||
      !looksLikeTableRow(line) ||
      isTableSeparator(line)
    )
      break;
    rawRows.push(extractTableCells(line));
    consumed++;
  }

  // Borderless tables are only distinguishable from pipe-carrying prose by
  // shape: a header plus at least one data row with uniform cell counts. A
  // GFM separator row removes that ambiguity, so strict tables skip the guard.
  if (!hasSeparator) {
    const cols0 = rawRows[0]?.length ?? 0;
    if (
      rawRows.length < 2 ||
      cols0 < 2 ||
      !rawRows.every((row) => row.length === cols0)
    ) {
      return null;
    }
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

  const sepTotal = tableRowOverhead(cols);
  const naturalWidth = naturalWidths.reduce((a, b) => a + b, 0) + sepTotal;

  if (!Number.isFinite(width) || naturalWidth <= width) {
    return { lines: renderGrid(cells, naturalWidths), consumed };
  }

  if (isDescriptorTable(cells)) {
    return { lines: renderDescriptorList(cells), consumed };
  }

  const targetContent = width - sepTotal;
  if (targetContent < cols * MIN_COL_WIDTH) {
    return { lines: renderKeyValue(cells), consumed };
  }

  return {
    lines: renderGrid(cells, fitColumnWidths(naturalWidths, targetContent)),
    consumed,
  };
}

// Shrink columns proportionally to fit the budget, bounded by MIN_COL_WIDTH
// and natural width.
function fitColumnWidths(
  naturalWidths: number[],
  targetContent: number,
): number[] {
  const sumNatural = naturalWidths.reduce((a, b) => a + b, 0) || 1;
  const widths = naturalWidths.map((natural) =>
    Math.min(
      natural,
      Math.max(
        MIN_COL_WIDTH,
        Math.floor((natural / sumNatural) * targetContent),
      ),
    ),
  );

  let overflow = widths.reduce((a, b) => a + b, 0) - targetContent;
  while (overflow > 0) {
    let widest = -1;
    for (let col = 0; col < widths.length; col++) {
      if (
        (widths[col] ?? 0) > MIN_COL_WIDTH &&
        (widest < 0 || (widths[col] ?? 0) > (widths[widest] ?? 0))
      ) {
        widest = col;
      }
    }
    if (widest < 0) break;
    const width = widths[widest];
    if (width == null) break;
    widths[widest] = width - 1;
    overflow--;
  }

  return widths;
}

// Lay cells into an aligned grid, wrapping each cell to its column width; the
// header row renders bold, underlined by a dash rule.
function renderGrid(
  cells: StyledSegment[][][],
  colWidths: number[],
): StyledSegment[][] {
  const out: StyledSegment[][] = [];

  cells.forEach((row, rowIdx) => {
    const wrapped = row.map((cell, col) => {
      const colWidth = colWidths[col] ?? 0;
      const text = cell.map((s) => s.text).join("");
      return wrapRanges(text, colWidth).map((range) =>
        padCell(sliceCellSegments(cell, range.start, range.end), colWidth),
      );
    });

    const height = Math.max(1, ...wrapped.map((lines) => lines.length));
    const isHeader = rowIdx === 0;
    for (let r = 0; r < height; r++) {
      const line: StyledSegment[] = [];
      for (let col = 0; col < colWidths.length; col++) {
        const colWidth = colWidths[col] ?? 0;
        const cellLine = wrapped[col]?.[r] ?? [{ text: " ".repeat(colWidth) }];
        // Slot = leading space, content padded to colWidth, trailing space.
        const slot: StyledSegment[] = [
          { text: " " },
          ...cellLine,
          { text: " " },
        ];
        line.push(...(isHeader ? applyFlag(slot, { bold: true }) : slot));
        if (col < colWidths.length - 1)
          line.push({ text: COL_SEP, rule: true });
      }
      out.push(line);
    }

    // Underline the header with a dash rule so the table reads as a table,
    // not a column of pipe-separated prose.
    if (isHeader) {
      const rule: StyledSegment[] = [];
      for (let col = 0; col < colWidths.length; col++) {
        const colWidth = colWidths[col] ?? 0;
        rule.push({ text: HEADER_RULE.repeat(colWidth + 2), rule: true });
        if (col < colWidths.length - 1)
          rule.push({ text: HEADER_CROSS, rule: true });
      }
      out.push(rule);
    }
  });

  return out;
}

const DESCRIPTOR_KEY_HEADERS = new Set(["id", "name", "agent", "tool", "key"]);
const DESCRIPTOR_VALUE_HEADERS = new Set([
  "role",
  "description",
  "summary",
  "details",
  "value",
]);

function isDescriptorTable(cells: StyledSegment[][][]): boolean {
  const headers = cells[0];
  if (headers === undefined || headers.length !== 2 || cells.length < 2)
    return false;
  const keyHeader = renderedText(headers[0] ?? [])
    .trim()
    .toLowerCase();
  const valueHeader = renderedText(headers[1] ?? [])
    .trim()
    .toLowerCase();
  return (
    DESCRIPTOR_KEY_HEADERS.has(keyHeader) &&
    DESCRIPTOR_VALUE_HEADERS.has(valueHeader)
  );
}

function renderDescriptorList(cells: StyledSegment[][][]): StyledSegment[][] {
  const [, ...dataRows] = cells;
  const out: StyledSegment[][] = [];
  dataRows.forEach((row, ri) => {
    if (ri > 0) out.push([]);
    out.push([
      ...applyFlag(row[0] ?? [], { bold: true }),
      { text: " - " },
      ...(row[1] ?? []),
    ]);
  });
  return out;
}

// Fallback for tables too wide to shrink: stack each data row as "Header:
// value" lines with bold keys; the event log wraps them as ordinary text.
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

// A table row is bordered (leading pipe) or borderless (split by a spaced
// pipe). Escaped pipes (\|) are literal and `||` is a logical-or, so neither
// counts as a separator.
function looksLikeTableRow(line: string): boolean {
  const stripped = line.replace(/\\\|/g, "");
  if (/\|\|/.test(stripped)) return false;
  return /^\s*\|/.test(stripped) || / \| /.test(stripped);
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

/**
 * Withhold a trailing bare heading marker (`####` with no title yet) so its
 * classification cannot flip under text already on screen.
 */
export function withholdIncompleteHeading(text: string): string {
  return text.replace(/(^|\n)#{1,6}[ \t]*$/, "$1");
}

/**
 * ATX heading (`#`–`######`) with a title. CommonMark allows up to 3 leading
 * spaces; a 4th is indented code, which this must reject.
 */
const ATX_HEADING_LINE_RE = /^ {0,3}#{1,6}[ \t]+\S.*$/;

/**
 * Opening fence: three or more backticks/tildes, up to three leading spaces
 * (CommonMark's indented-code limit), then an info string. Distinct from
 * `FENCE_OPEN_RE`'s looser `\s*` matcher — do not unify.
 */
const COMMONMARK_FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Closing fence: the fence run and trailing whitespace only, so not the
 * opener regex again ("```stillcode" stays fence content).
 */
const COMMONMARK_FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * Lines inside a fenced block: a leading `#` is a shell comment, never a
 * heading. A closer needs the opener's char and a run at least as long.
 */
function fencedLineMask(lines: readonly string[]): boolean[] {
  const inside = new Array<boolean>(lines.length).fill(false);
  let opener: { char: string; length: number } | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line == null) throw new Error("fence mask line missing");
    if (opener === null) {
      const match = line.match(COMMONMARK_FENCE_OPEN_RE);
      if (match) {
        inside[i] = true;
        const run = match[1];
        const char = run?.[0];
        if (run == null || char == null)
          throw new Error("fence opener capture missing");
        opener = { char, length: run.length };
      }
      continue;
    }
    inside[i] = true;
    const close = line.match(COMMONMARK_FENCE_CLOSE_RE);
    const closeRun = close?.[1];
    const closeChar = closeRun?.[0];
    if (
      closeRun != null &&
      closeChar === opener.char &&
      closeRun.length >= opener.length
    ) {
      opener = null;
    }
  }
  return inside;
}

/**
 * A body split at the last heading that already has content behind it.
 * Default block mode merges a heading into the paragraph after it, so every
 * keystroke there re-highlights the settled heading (flicker); giving the
 * heading its own non-streaming `MarkdownRenderable` stops that.
 */
export interface MarkdownSplit {
  readonly frozen: string;
  readonly live: string;
  /** Blank source lines between the heading and what follows it (0 or 1). */
  readonly gapRows: number;
}

export function splitAtSettledHeading(text: string): MarkdownSplit | null {
  const lines = text.split("\n");
  const insideFence = fencedLineMask(lines);
  let boundary = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line == null) continue;
    if (!insideFence[i] && ATX_HEADING_LINE_RE.test(line)) boundary = i;
  }
  // No heading, or the last one is still the open tail: nothing to freeze.
  if (boundary === -1 || boundary >= lines.length - 1) return null;
  const rest = lines.slice(boundary + 1);
  const firstContent = rest.findIndex((line) => line.trim().length > 0);
  // Heading closed but nothing has started under it yet.
  if (firstContent === -1) return null;
  return {
    frozen: lines.slice(0, boundary + 1).join("\n"),
    live: rest.slice(firstContent).join("\n"),
    gapRows: firstContent > 0 ? 1 : 0,
  };
}

/**
 * Split at the last settled block boundary: heading, fence closer, or table
 * row. Null when none has content behind it. The walk mirrors parseMarkdown's
 * dispatch order, so halves render the same apart as together. An unclosed
 * fence consumes to the end; blank lines before the tail collapse to one.
 */
export function splitAtSettledBlock(withheld: string): MarkdownSplit | null {
  const lines = withheld.split("\n");
  const boundaries = new Set<number>();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (FENCE_OPEN_RE.test(line)) {
      let closer = -1;
      for (let j = i + 1; j < lines.length; j += 1) {
        if (FENCE_CLOSE_RE.test(lines[j] ?? "")) {
          closer = j;
          break;
        }
      }
      if (closer === -1) break;
      boundaries.add(closer);
      i = closer + 1;
      continue;
    }
    if (INDENTED_CODE_RE.test(line)) {
      i += 1;
      while (i < lines.length && INDENTED_CODE_RE.test(lines[i] ?? "")) i += 1;
      continue;
    }
    if (looksLikeTableRow(line)) {
      const next = lines[i + 1];
      const hasSeparator = next !== undefined && isTableSeparator(next);
      const rawRows: string[][] = [extractTableCells(line)];
      let consumed = 1;
      if (hasSeparator) {
        rawRows.push(extractTableCells(next ?? ""));
        consumed = 2;
      }
      while (i + consumed < lines.length) {
        const rowLine = lines[i + consumed] ?? "";
        if (!looksLikeTableRow(rowLine) || isTableSeparator(rowLine)) break;
        rawRows.push(extractTableCells(rowLine));
        consumed += 1;
      }
      const firstWidth = rawRows[0]?.length ?? 0;
      const valid =
        hasSeparator ||
        (rawRows.length >= 2 &&
          firstWidth >= 2 &&
          rawRows.every((row) => row.length === firstWidth));
      if (valid) {
        boundaries.add(i + consumed - 1);
        i += consumed;
        continue;
      }
    }
    if (ATX_HEADING_LINE_RE.test(line)) boundaries.add(i);
    i += 1;
  }
  const ordered = [...boundaries].sort((a, b) => b - a);
  for (const boundary of ordered) {
    if (boundary >= lines.length - 1) continue;
    const rest = lines.slice(boundary + 1);
    const firstContent = rest.findIndex((entry) => entry.trim().length > 0);
    if (firstContent === -1) continue;
    return {
      frozen: lines.slice(0, boundary + 1).join("\n"),
      live: rest.slice(firstContent).join("\n"),
      gapRows: firstContent > 0 ? 1 : 0,
    };
  }
  return null;
}

/** Paint state for one streaming markdown row across repaints. */
export interface StreamMarkdownSnapshot {
  readonly content: string;
  readonly frozen: string | null;
  readonly width: number;
  readonly streaming: boolean;
}

/**
 * Repaint the frozen node only on a moved boundary, resize, streaming-flag
 * flip, or non-append edit (rollback/rewrite).
 */
export function nextStreamMarkdownState(
  prev: StreamMarkdownSnapshot | null,
  content: string,
  frozen: string | null,
  width: number,
  streaming: boolean,
): { state: StreamMarkdownSnapshot; paintFrozen: boolean } {
  const state: StreamMarkdownSnapshot = { content, frozen, width, streaming };
  if (prev === null) return { state, paintFrozen: true };
  const paintFrozen =
    prev.frozen !== frozen ||
    prev.width !== width ||
    prev.streaming !== streaming ||
    !content.startsWith(prev.content);
  return { state, paintFrozen };
}
