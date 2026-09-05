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
  // Wall-clock start of a still-running tool call. Present only on the first
  // segment of a pending tool row; the event log animates such rows with a live
  // spinner and elapsed clock instead of painting a static line.
  toolRunningSince?: number;
}

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
      segments.push({ text, link: true, ...(url.length > 0 ? { linkUrl: url } : {}) });
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

const FENCE_OPEN_RE = /^\s*(```+|~~~+)/;
const FENCE_CLOSE_RE = /^\s*(```+|~~~+)\s*$/;
// A closing fence typed one character at a time: zero, one, or two lone fence
// chars on a line, not yet the three needed to close. Zero chars covers the
// still-empty line right after the body's last newline — the first position a
// closing fence could start from. Stripped from the streaming tail so the
// block does not flicker (a visible line appearing then disappearing) as the
// fence is typed in.
const PARTIAL_FENCE_RE = /^\s*[`~]{0,2}\s*$/;
const INDENTED_CODE_RE = /^(?: {4}|\t)(.*)$/;
const CODE_GUTTER = "▏ ";

interface FencedBlock {
  lines: StyledSegment[][];
  consumed: number;
}

// Always paint the gutter, including on blank body lines. Skipping empty lines
// left disconnected bar fragments (a floating language cap, gaps mid-block, a
// dangling foot) instead of one continuous container.
function codeGutterPrefix(line: StyledSegment[]): StyledSegment[] {
  return [{ text: CODE_GUTTER, code: true, dim: true, codeFence: true }, ...line];
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

// Collect a fenced block starting at `start`, highlight its body by the fence's
// language token, and frame it with cap/gutter glyphs. The block may be
// unclosed while it streams; in that case a nascent closing fence is dropped so
// the trailing block re-highlights cleanly rather than flickering.
function parseFencedBlock(input: string[], start: number, width: number): FencedBlock {
  const language = input[start]!.match(/^\s*(?:```+|~~~+)\s*([^\s`]*)/)?.[1] || undefined;
  const body: string[] = [];
  let i = start + 1;
  let closed = false;
  for (; i < input.length; i++) {
    if (FENCE_CLOSE_RE.test(input[i]!)) {
      closed = true;
      break;
    }
    body.push(input[i]!);
  }
  const consumed = closed ? i - start + 1 : i - start;

  if (!closed && body.length > 0 && PARTIAL_FENCE_RE.test(body[body.length - 1]!)) {
    body.pop();
  }

  const capLabel = language && language.length > 0 ? language : "code";
  const lines: StyledSegment[][] = [fencedCap(capLabel)];
  if (body.length > 0) {
    lines.push(...highlightCode(body.join("\n"), language, width).map(codeGutterPrefix));
  }
  if (closed) lines.push(fencedFoot());
  return { lines, consumed };
}

function parseIndentedCodeBlock(input: string[], start: number, width: number): FencedBlock {
  const body: string[] = [];
  let i = start;
  for (; i < input.length; i++) {
    const match = input[i]!.match(INDENTED_CODE_RE);
    if (!match) break;
    body.push(match[1] ?? "");
  }
  const lines: StyledSegment[][] = [fencedCap("code")];
  if (body.length > 0) {
    lines.push(...highlightCode(body.join("\n"), undefined, width).map(codeGutterPrefix));
  }
  lines.push(fencedFoot());
  return { lines, consumed: i - start };
}

export type MemoizedParseMarkdown = ((text: string, width?: number) => StyledSegment[][]) & {
  clear: () => void;
};

const DEFAULT_MARKDOWN_CACHE_ENTRIES = 32;

// A parsed block's segments never change for a fixed (text, width) pair, but
// resize-free re-renders (state changes elsewhere in the TUI, unrelated
// re-mounts) ask parseMarkdown for the same pair repeatedly. Wrap it in a
// small bounded LRU so those re-renders are a cache hit instead of a full
// re-parse. Capacity is small and callers clear() it alongside the
// coarser-grained per-block line cache (see event-log.tsx / app.tsx) so this
// cache's lifetime tracks that one rather than growing across a whole session.
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

// `width` is the column budget the rendered output must fit within (the same
// width the event log wraps to). Tables use it to decide their layout; default
// Infinity lays them out at natural width.
export function parseMarkdown(text: string, width = Infinity): StyledSegment[][] {
  const lines: StyledSegment[][] = [];
  const input = text.split("\n");

  for (let i = 0; i < input.length; i++) {
    const line = input[i]!;

    // Fenced code block (``` or ~~~). The whole block is collected so its body
    // can be syntax-highlighted by the fence's language token; the delimiter
    // lines render as blank separators.
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
    // Give a heading air above it so each section reads as a distinct block
    // rather than crowding the paragraph that precedes it. Skip when the heading
    // opens the message or already follows a blank line.
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

// Internal separators only (no outer frame), matching how opencode/Glamour draw
// tables: a unicode bar between columns and a header rule of box-drawing dashes.
// Outer borders were deliberately avoided — they add width overhead and neither
// reference TUI draws them in the chat transcript.
const COL_SEP = "│";
const HEADER_RULE = "─";
const HEADER_CROSS = "┼";
const MIN_COL_WIDTH = 6;

// Each cell slot is the content padded to its column width plus a leading and
// trailing space, so cell text never butts against the bar. Columns are joined
// by a single bar, so the per-row overhead is one bar per gap plus two spaces
// of slot padding on every column.
function tableRowOverhead(cols: number): number {
  return cols - 1 + cols * 2;
}

function renderedLength(segments: StyledSegment[]): number {
  return segments.reduce((sum, seg) => sum + stringWidth(seg.text), 0);
}

function renderedText(segments: StyledSegment[]): string {
  return segments.map((seg) => seg.text).join("");
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
  if (header === undefined || !looksLikeTableRow(header)) return null;

  const next = lines[startIndex + 1];
  const hasSeparator = next !== undefined && isTableSeparator(next);

  const rawRows: string[][] = [extractTableCells(header)];
  let consumed = hasSeparator ? 2 : 1;

  for (let i = startIndex + consumed; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || !looksLikeTableRow(line) || isTableSeparator(line)) break;
    rawRows.push(extractTableCells(line));
    consumed++;
  }

  // The model routinely emits borderless tables with no separator row. Those are
  // only distinguishable from prose that happens to contain a pipe by their
  // shape: a header plus at least one data row, every row the same number of
  // multi-column cells. A proper GFM separator row removes that ambiguity, so
  // strict tables skip the shape guard.
  if (!hasSeparator) {
    const cols0 = rawRows[0]?.length ?? 0;
    if (rawRows.length < 2 || cols0 < 2 || !rawRows.every((row) => row.length === cols0)) {
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
      if (
        (widths[col] ?? 0) > MIN_COL_WIDTH &&
        (widest < 0 || (widths[col] ?? 0) > (widths[widest] ?? 0))
      ) {
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
// stacking the wrapped lines so columns stay aligned across visual rows. The
// first row is the header: it renders bold and is underlined by a dash rule.
function renderGrid(cells: StyledSegment[][][], colWidths: number[]): StyledSegment[][] {
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
        const slot: StyledSegment[] = [{ text: " " }, ...cellLine, { text: " " }];
        line.push(...(isHeader ? applyFlag(slot, { bold: true }) : slot));
        if (col < colWidths.length - 1) line.push({ text: COL_SEP, rule: true });
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
        if (col < colWidths.length - 1) rule.push({ text: HEADER_CROSS, rule: true });
      }
      out.push(rule);
    }
  });

  return out;
}

const DESCRIPTOR_KEY_HEADERS = new Set(["id", "name", "agent", "tool", "key"]);
const DESCRIPTOR_VALUE_HEADERS = new Set(["role", "description", "summary", "details", "value"]);

function isDescriptorTable(cells: StyledSegment[][][]): boolean {
  const headers = cells[0];
  if (headers === undefined || headers.length !== 2 || cells.length < 2) return false;
  const keyHeader = renderedText(headers[0] ?? [])
    .trim()
    .toLowerCase();
  const valueHeader = renderedText(headers[1] ?? [])
    .trim()
    .toLowerCase();
  return DESCRIPTOR_KEY_HEADERS.has(keyHeader) && DESCRIPTOR_VALUE_HEADERS.has(valueHeader);
}

function renderDescriptorList(cells: StyledSegment[][][]): StyledSegment[][] {
  const [, ...dataRows] = cells;
  const out: StyledSegment[][] = [];
  dataRows.forEach((row, ri) => {
    if (ri > 0) out.push([]);
    out.push([...applyFlag(row[0] ?? [], { bold: true }), { text: " - " }, ...(row[1] ?? [])]);
  });
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

// A table row is either a bordered GFM row (leading pipe) or a borderless row
// whose cells are split by a spaced pipe. Escaped pipes (\|) are literal content
// and a `||` is a logical-or operator, so neither counts as a cell separator.
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
 * Markdown source with a half-arrived heading marker withheld.
 *
 * A trailing `####` with nothing after it yet is not a heading — it is literal
 * text, and that is what the parser makes of it, so the row paints the bare
 * markers for one delta and drops them the moment the title's first character
 * lands. Holding that line back until it has content keeps a line's
 * classification from flipping under text that is already on screen.
 */
export function withholdIncompleteHeading(text: string): string {
  return text.replace(/(^|\n)#{1,6}[ \t]*$/, "$1");
}

/**
 * An ATX heading line (`#` through `######`) with a title, not a bare marker.
 * CommonMark allows the marker up to 3 spaces in; a 4th makes it indented code
 * instead, which this line still has to reject.
 */
const ATX_HEADING_LINE_RE = /^ {0,3}#{1,6}[ \t]+\S.*$/;

/**
 * A fenced code block's opening delimiter: three or more backticks or tildes,
 * optionally indented up to three spaces (CommonMark's limit before a fence
 * counts as indented code instead), followed by anything (an info string,
 * e.g. the "bash" in ` ```bash `).
 *
 * Distinct from `FENCE_OPEN_RE` above, which is the streaming highlighter's
 * looser `\s*` matcher — do not unify the two.
 */
const COMMONMARK_FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * A fenced code block's closing delimiter. Unlike the opener, CommonMark
 * requires the closing line to contain nothing but the fence run and
 * trailing whitespace — "```stillcode" does not close a fence, it is more
 * fence content — so this is deliberately not just `COMMONMARK_FENCE_OPEN_RE`
 * again.
 */
const COMMONMARK_FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * Lines that are inside a fenced code block, where a leading `#` is a shell
 * comment or similar and never a heading. A closer needs the same character
 * as the opener and a run at least as long — a shorter run, a run of the
 * other character, or a closing-shaped line carrying trailing text is just
 * more fence content, per CommonMark.
 */
function fencedLineMask(lines: readonly string[]): boolean[] {
  const inside = new Array<boolean>(lines.length).fill(false);
  let opener: { char: string; length: number } | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    if (opener === null) {
      const match = lines[i]!.match(COMMONMARK_FENCE_OPEN_RE);
      if (match) {
        inside[i] = true;
        opener = { char: match[1]![0]!, length: match[1]!.length };
      }
      continue;
    }
    inside[i] = true;
    const close = lines[i]!.match(COMMONMARK_FENCE_CLOSE_RE);
    if (close && close[1]![0] === opener.char && close[1]!.length >= opener.length) {
      opener = null;
    }
  }
  return inside;
}

/**
 * A markdown body split at the last heading that already has content behind
 * it: everything through that heading, and everything after it.
 *
 * The renderer's own incremental parser only reuses a block whose raw text is
 * unchanged; the default block mode merges a heading into the same raw chunk
 * as the paragraph that follows it, so every keystroke of that paragraph
 * changes the merged chunk's raw text and forces the heading's already-settled
 * markup to re-highlight too — visibly flickering while the rest of the
 * message keeps streaming in. Rendering the two halves as separate
 * `MarkdownRenderable`s keeps the heading's renderer untouched once it is no
 * longer the one growing, without changing how paragraphs, lists or tables
 * inside either half are laid out (both halves still use the library's
 * default block mode).
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
    if (!insideFence[i] && ATX_HEADING_LINE_RE.test(lines[i]!)) boundary = i;
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
