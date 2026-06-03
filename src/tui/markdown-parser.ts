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

  while (remaining.length > 0) {
    // Bold: **text** or __text__
    const boldMatch = remaining.match(/^\*\*(.+?)\*\*|^__(.+?)__/);
    if (boldMatch) {
      const content = boldMatch[1] || boldMatch[2] || "";
      if (content) {
        segments.push({ text: content, bold: true });
        remaining = remaining.slice(boldMatch[0].length);
        continue;
      }
    }

    // Strikethrough: ~~text~~
    const strikeMatch = remaining.match(/^~~(.+?)~~/);
    if (strikeMatch && strikeMatch[1]) {
      segments.push({ text: strikeMatch[1], strikethrough: true });
      remaining = remaining.slice(strikeMatch[0].length);
      continue;
    }

    // Italic: *text* or _text_ (but not ** or __)
    const italicMatch = remaining.match(/^(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)|^(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/);
    if (italicMatch) {
      const content = italicMatch[1] || italicMatch[2] || "";
      if (content) {
        segments.push({ text: content, italic: true });
        remaining = remaining.slice(italicMatch[0].length);
        continue;
      }
    }

    // Inline code: `text`
    const codeMatch = remaining.match(/^`(.+?)`/);
    if (codeMatch && codeMatch[1]) {
      segments.push({ text: codeMatch[1], code: true });
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }

    // Link: [text](url) — show the text, then the url in parentheses so it is
    // not lost in a terminal.
    const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch && linkMatch[1] && linkMatch[2]) {
      segments.push({ text: linkMatch[1], link: true });
      segments.push({ text: ` (${linkMatch[2]})` });
      remaining = remaining.slice(linkMatch[0].length);
      continue;
    }

    // Plain text up to the next possible marker.
    const plainMatch = remaining.match(/^[^*_`~[]+/);
    if (plainMatch && plainMatch[0]) {
      segments.push({ text: plainMatch[0] });
      remaining = remaining.slice(plainMatch[0].length);
      continue;
    }

    // A marker character that did not start a token (e.g. a lone `[`): emit it
    // as plain text and move on.
    segments.push({ text: remaining[0]! });
    remaining = remaining.slice(1);
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

  for (const line of text.split("\n")) {
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
    lines.push(parseLine(line));
  }

  return lines;
}
