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
};

function parseSegments(text: string): StyledSegment[] {
  const segments: StyledSegment[] = [];
  let remaining = text;
  let offset = 0;

  while (remaining.length > 0) {
    // Bold: **text** or __text__
    const boldMatch = remaining.match(/^\*\*(.+?)\*\*|^__(.+?)__/);
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
    const strikeMatch = remaining.match(/^~~(.+?)~~/);
    if (strikeMatch && strikeMatch[1]) {
      segments.push({ text: strikeMatch[1], strikethrough: true });
      remaining = remaining.slice(strikeMatch[0].length);
      offset += strikeMatch[0].length;
      continue;
    }

    // Italic: *text* or _text_ (but not ** or __)
    // For _, enforce word boundaries: must open after start/whitespace/punctuation
    // and close before end/whitespace/punctuation. For *, intraword is allowed.
    const starMatch = remaining.match(/^(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/);
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
      const isPrecededByNonWord = !prevChar || !/[a-zA-Z0-9_]/.test(prevChar);

      if (isPrecededByNonWord) {
        const closeMatch = remaining.match(/^_(?!_)(.+?)_(?!_)/);
        if (closeMatch && closeMatch[1]) {
          segments.push({ text: closeMatch[1], italic: true });
          remaining = remaining.slice(closeMatch[0].length);
          offset += closeMatch[0].length;
          continue;
        }
      }
    }

    // Inline code: `text`
    const codeMatch = remaining.match(/^`(.+?)`/);
    if (codeMatch && codeMatch[1]) {
      segments.push({ text: codeMatch[1], code: true });
      remaining = remaining.slice(codeMatch[0].length);
      offset += codeMatch[0].length;
      continue;
    }

    // Link: [text](url) — show the text, then the url in parentheses if short.
    // For URLs with balanced parens (e.g., fn(arg)), try to match a single level
    // of nesting. If URL is long (> 40 chars), omit the URL from output.
    const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]*(?:\([^)]*\))?[^)]*)\)/);
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
    const plainMatch = remaining.match(/^[^*_`~[]+/);
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

export function parseMarkdown(text: string): StyledSegment[][] {
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

    const table = parseTableBlock(input, i);
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

function parseTableBlock(lines: string[], startIndex: number): ParsedTable | null {
  const header = lines[startIndex];
  const separator = lines[startIndex + 1];
  if (header === undefined || separator === undefined) return null;
  if (!isTableRow(header) || !isTableSeparator(separator)) return null;

  const rows: string[][] = [extractTableCells(header)];
  let consumed = 2;

  for (let i = startIndex + 2; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || !isTableRow(line)) break;
    rows.push(extractTableCells(line));
    consumed++;
  }

  const width = Math.max(...rows.map((row) => row.length));
  const padded = rows.map((row) => row.concat(Array(width - row.length).fill("")));
  const colWidths = Array.from({ length: width }, (_, col) =>
    Math.max(...padded.map((row) => row[col]?.length ?? 0)),
  );

  const rendered = padded.map((row) => [
    {
      text: row
        .map((cell, col) => cell.padEnd(colWidths[col] ?? 0, " "))
        .join(" | "),
    },
  ]);

  return { lines: rendered, consumed };
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
